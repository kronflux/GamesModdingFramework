local Fs = require("gmfdumper.fs")
local Manifest = require("gmfdumper.manifest")
local Runner = require("gmfdumper.runner")

local tests = {}

-- Builds a runner over fake steps. The schedule runs each step at once, so a test is
-- finished when start() returns.
local function make(t, steps, overrides)
    local dir = t.support.temp_dir("run")
    local fs = Fs.new(nil)
    local log = {}
    local manifest
    local options = {
        steps = steps,
        fs = fs,
        schedule = function(fn) fn() end,
        log = function(message) log[#log + 1] = message end,
        clock = os.clock,
        make_run = function()
            return dir, {}
        end,
        make_manifest = function(run_dir, header, ids)
            manifest = Manifest.new(fs, run_dir, header, ids)
            return manifest
        end,
        make_context = function(run_dir)
            return { run_dir = run_dir, fs = fs }
        end,
    }
    for key, value in pairs(overrides or {}) do
        options[key] = value
    end
    local runner = Runner.new(options)
    return runner, function() return manifest end, log
end

local function step(id, run, extra)
    local s = { id = id, profiles = { full = true, quick = true }, run = run }
    for key, value in pairs(extra or {}) do
        s[key] = value
    end
    return s
end

local function ok_step(id, order)
    return step(id, function()
        if order then
            order[#order + 1] = id
        end
        return {}
    end)
end

function tests.runs_every_step_in_order(t)
    local order = {}
    local runner, manifest = make(t, { ok_step("a", order), ok_step("b", order), ok_step("c", order) })
    t:ok(runner:start({ profile = "full" }))
    t:eq(table.concat(order, ","), "a,b,c")
    local counts = manifest():counts()
    t:eq(counts.ok, 3)
    t:no(runner:is_running(), "finished")
    t:ok(manifest().data.finished, "manifest finished")
end

-- AC-3
function tests.a_failing_step_does_not_stop_the_run(t)
    local order = {}
    local runner, manifest = make(t, {
        ok_step("a", order),
        step("names", function() return nil, "boom" end),
        ok_step("c", order),
    })
    runner:start({ profile = "full" })
    t:eq(manifest():get("names").status, "failed")
    t:eq(manifest():get("names").error, "boom")
    t:eq(manifest():get("c").status, "ok")
    t:eq(table.concat(order, ","), "a,c")
end

function tests.a_raising_step_is_failed_with_its_message(t)
    local runner, manifest = make(t, {
        step("a", function() error("kaput") end),
        ok_step("b"),
    })
    runner:start({ profile = "full" })
    t:eq(manifest():get("a").status, "failed")
    t:ok(manifest():get("a").error:find("kaput", 1, true), "message kept")
    t:eq(manifest():get("b").status, "ok")
end

function tests.second_start_during_a_run_is_refused(t)
    local queued = {}
    local runner = make(t, { ok_step("a"), ok_step("b") }, {
        schedule = function(fn) queued[#queued + 1] = fn end,
    })
    t:ok(runner:start({ profile = "full" }))
    t:ok(runner:is_running(), "running while steps are queued")
    local ok, err = runner:start({ profile = "full" })
    t:no(ok)
    t:eq(err, "run in progress")
    -- Drain the queue: each step schedules the next.
    local i = 1
    while queued[i] do
        queued[i]()
        i = i + 1
    end
    t:no(runner:is_running(), "finished after draining")
end

function tests.only_runs_the_named_steps(t)
    local order = {}
    local runner, manifest = make(t, { ok_step("a", order), ok_step("names", order), ok_step("c", order) })
    runner:start({ only = { "names" } })
    t:eq(table.concat(order, ","), "names")
    t:eq(manifest():get("a").status, "skipped")
    t:eq(manifest():get("a").reason, "not requested")
end

function tests.unknown_step_name_is_refused(t)
    local runner = make(t, { ok_step("a") })
    local ok, err = runner:start({ only = { "nope" } })
    t:no(ok)
    t:ok(err:find("unknown step", 1, true))
    t:no(runner:is_running())
end

function tests.profile_native_and_disabled_skips(t)
    local runner, manifest = make(t, {
        step("load_assets", function() return {} end, { profiles = { full = true } }),
        step("tmap", function() return {} end, { needs_native = true }),
        step("uht", function() return {} end, { disabled = true }),
        ok_step("z"),
    }, { has_native = false })
    runner:start({ profile = "quick" })
    t:eq(manifest():get("load_assets").reason, "not in profile")
    t:eq(manifest():get("tmap").reason, "native unavailable")
    t:eq(manifest():get("uht").reason, "disabled")
    t:eq(manifest():get("z").status, "ok")
end

function tests.step_marked_running_before_it_runs(t)
    local seen
    local manifest_ref
    local runner, manifest = make(t, {
        step("a", function()
            seen = manifest_ref():get("a").status
            return {}
        end),
    })
    manifest_ref = manifest
    runner:start({ profile = "full" })
    t:eq(seen, "running")
end

function tests.files_and_seconds_are_recorded(t)
    local runner, manifest = make(t, {
        step("a", function() return { { path = "A/x.txt", bytes = 7 } } end),
    })
    runner:start({ profile = "full" })
    local a = manifest():get("a")
    t:eq(a.files[1].bytes, 7)
    t:ok(type(a.seconds) == "number", "seconds recorded")
end

function tests.summary_line_counts_statuses(t)
    local runner, _, log = make(t, {
        ok_step("a"),
        step("b", function() return nil, "x" end),
        step("c", function() return {} end, { profiles = { full = true } }),
    })
    runner:start({ profile = "quick" })
    local last = log[#log]
    t:ok(last:find("1 ok", 1, true), last)
    t:ok(last:find("1 failed", 1, true), last)
    t:ok(last:find("1 skipped", 1, true), last)
end

function tests.steps_after_a_raising_step_still_run_and_a_step_can_skip_itself(t)
    local order = {}
    local runner, manifest = make(t, {
        ok_step("load", order),
        step("mid", function() error("x") end),
        step("unload", function() order[#order + 1] = "unload" return {} end),
        step("self_skip", function() return "skip", "nothing to do" end),
    })
    runner:start({ profile = "full" })
    t:eq(table.concat(order, ","), "load,unload")
    t:eq(manifest():get("self_skip").status, "skipped")
    t:eq(manifest():get("self_skip").reason, "nothing to do")
end

function tests.a_held_step_is_followed_by_the_next_without_a_schedule(t)
    local order, queued = {}, {}
    local function held(id)
        local s = ok_step(id, order)
        s.hold = true
        return s
    end
    local runner, manifest = make(t, { ok_step("a", order), held("b"), held("c"), ok_step("d", order), ok_step("e", order) }, {
        schedule = function(fn) queued[#queued + 1] = fn end,
    })
    runner:start({ profile = "full" })
    queued[1]()
    t:eq(table.concat(order, ","), "a", "an ordinary step yields after itself")
    queued[2]()
    t:eq(table.concat(order, ","), "a,b,c,d", "b and c hold on, so d runs in the same call")
    queued[3]()
    queued[4]()
    t:eq(manifest():counts().ok, 5)
    t:no(runner:is_running())
end

function tests.a_held_step_that_fails_or_is_skipped_still_holds(t)
    local order, queued = {}, {}
    local runner = make(t, {
        step("b", function() error("x") end, { hold = true }),
        step("c", function() return {} end, { hold = true, profiles = { full = true } }),
        ok_step("d", order),
    }, { schedule = function(fn) queued[#queued + 1] = fn end })
    runner:start({ profile = "quick" })
    queued[1]()
    t:eq(table.concat(order, ","), "d", "a failed and a skipped held step do not hand the game a tick")
end

function tests.failing_to_schedule_the_first_step_frees_the_runner(t)
    local runner, manifest, log = make(t, { ok_step("a") }, {
        schedule = function() error("no game thread hook") end,
    })
    local ok, err = runner:start({ profile = "full" })
    t:no(ok)
    t:ok(err:find("could not schedule", 1, true), err)
    t:ok(err:find("no game thread hook", 1, true), err)
    t:no(runner:is_running(), "the runner is not left running")
    t:eq(manifest():get("a").status, "pending", "the manifest shows the step never ran")
    t:eq(manifest().data.finished, nil)
    t:ok(log[#log]:find("run stopped", 1, true))
end

function tests.failing_to_schedule_a_later_step_frees_the_runner(t)
    local calls = 0
    local runner, manifest = make(t, { ok_step("a"), ok_step("b") }, {
        schedule = function(fn)
            calls = calls + 1
            if calls > 1 then
                error("hook went away")
            end
            fn()
        end,
    })
    t:ok(runner:start({ profile = "full" }))
    t:no(runner:is_running())
    t:eq(manifest():get("a").status, "ok")
    t:eq(manifest():get("b").status, "pending")
    -- A new run can start afterwards.
    calls = -100
    t:ok(runner:start({ profile = "full" }))
end

function tests.summary_is_logged_before_the_finish_callback(t)
    local order = {}
    local runner = make(t, { ok_step("a") }, {
        log = function(message)
            if message:find("run finished", 1, true) then
                order[#order + 1] = "summary"
            end
        end,
        on_finish = function() order[#order + 1] = "callback" end,
    })
    runner:start({ profile = "full" })
    t:eq(table.concat(order, ","), "summary,callback")
end

return tests
