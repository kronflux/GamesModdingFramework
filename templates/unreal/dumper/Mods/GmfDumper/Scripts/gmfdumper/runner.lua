-- Runs dump steps in order, one step per scheduled call, and records each result in the
-- manifest. A step that fails or raises does not stop the steps after it.
--
-- A step is { id, profiles = { full = bool, quick = bool }, needs_native = bool,
-- disabled = bool, run = function(ctx) }. run returns one of:
--   files                 a list of { path, bytes } tables: the step is "ok"
--   nil, message          the step is "failed"
--   "skip", reason        the step is "skipped"

local Runner = {}
Runner.__index = Runner

function Runner.new(options)
    local self = setmetatable({}, Runner)
    self.steps = options.steps
    self.fs = options.fs
    self.schedule = options.schedule
    self.log = options.log or function() end
    self.clock = options.clock or os.clock
    self.make_run = options.make_run
    self.make_manifest = options.make_manifest
    self.make_context = options.make_context
    self.on_finish = options.on_finish
    self.on_stopped = options.on_stopped
    self.on_start_failed = options.on_start_failed
    self.has_native = options.has_native ~= false
    self.running = false
    return self
end

function Runner:is_running()
    return self.running
end

-- Returns nil when the step should run, or the reason it is skipped.
local function skip_reason(self, step, request)
    if request.only then
        if not request.only_set[step.id] then
            return "not requested"
        end
    else
        if step.disabled then
            return "disabled"
        end
        if not (step.profiles and step.profiles[request.profile]) then
            return "not in profile"
        end
    end
    if step.needs_native and not self.has_native then
        return "native unavailable"
    end
    return nil
end

local function run_step(self, step, ctx, manifest)
    manifest:set(step.id, { status = "running" })
    self.log("step " .. step.id .. " started")
    local started = self.clock()
    local results = table.pack(xpcall(step.run, debug.traceback, ctx))
    local seconds = math.floor((self.clock() - started) * 1000 + 0.5) / 1000

    if not results[1] then
        local message = tostring(results[2])
        manifest:set(step.id, { status = "failed", seconds = seconds, error = message })
        self.log("step " .. step.id .. " failed: " .. message)
        return
    end

    local first, second = results[2], results[3]
    if first == "skip" then
        manifest:set(step.id, { status = "skipped", seconds = seconds, reason = tostring(second or "skipped") })
        self.log("step " .. step.id .. " skipped: " .. tostring(second))
    elseif type(first) == "table" then
        manifest:set(step.id, { status = "ok", seconds = seconds, files = first })
        self.log(string.format("step %s ok, %.1f s, %d entries", step.id, seconds, #first))
    else
        local message = tostring(second or "step returned no result")
        manifest:set(step.id, { status = "failed", seconds = seconds, error = message })
        self.log("step " .. step.id .. " failed: " .. message)
    end
end

function Runner:start(request)
    if self.running then
        return nil, "run in progress"
    end
    request = request or {}
    request.profile = request.profile or "full"

    if request.only then
        local known = {}
        for _, step in ipairs(self.steps) do
            known[step.id] = true
        end
        request.only_set = {}
        for _, id in ipairs(request.only) do
            if not known[id] then
                return nil, "unknown step: " .. tostring(id)
            end
            request.only_set[id] = true
        end
    end

    local run_dir, header = self.make_run(request)
    if not run_dir then
        return nil, tostring(header or "could not create the run folder")
    end
    header = header or {}
    header.profile = request.only and "custom" or request.profile

    local ids = {}
    for _, step in ipairs(self.steps) do
        ids[#ids + 1] = step.id
    end
    local manifest, manifest_err = self.make_manifest(run_dir, header, ids)
    if not manifest then
        local reason = tostring(manifest_err or "could not write the manifest")
        -- The run folder exists, so whoever waits for this run is told that it ended.
        if self.on_start_failed then
            local told, problem = pcall(self.on_start_failed, run_dir, reason, request)
            if not told then
                self.log("the start-failed handler failed: " .. tostring(problem))
            end
        end
        return nil, reason
    end

    local ctx = self.make_context(run_dir, request) or {}
    ctx.run_dir = ctx.run_dir or run_dir
    ctx.manifest = manifest
    ctx.log = ctx.log or self.log

    self.running = true
    self.log("run started: " .. run_dir)

    -- Scheduling can fail, for example when UE4SS has no game-thread hook available. The
    -- run then stops where it is: the manifest keeps the remaining steps as "pending", and
    -- the runner is free for the next command. The stop handler is told, so that it can
    -- write the file that marks the end of the run.
    local function schedule(fn)
        local ok, err = pcall(self.schedule, fn)
        if not ok then
            self.running = false
            local reason = "could not schedule the next step: " .. tostring(err)
            self.log("run stopped: " .. reason)
            if self.on_stopped then
                local told, problem = pcall(self.on_stopped, ctx, manifest, reason)
                if not told then
                    self.log("the stop handler failed: " .. tostring(problem))
                end
            end
            return nil, tostring(err)
        end
        return true
    end

    local index = 0
    local function next_step()
        -- Runs one step, and goes straight on while the step just run is marked `hold`.
        -- Between two scheduled calls the game gets a tick, and in a tick the engine can
        -- collect garbage: objects the dump has loaded but the game does not use are
        -- removed, and every later step would describe less than the earlier ones did.
        -- A held step therefore hands over to the next one without giving the game a tick.
        while true do
            index = index + 1
            local step = self.steps[index]
            if not step then
                manifest:finish()
                local counts = manifest:counts()
                self.running = false
                self.log(string.format("run finished: %d ok, %d failed, %d skipped. Folder: %s",
                    counts.ok, counts.failed, counts.skipped, run_dir))
                if self.on_finish then
                    local finished, problem = pcall(self.on_finish, ctx, manifest)
                    if not finished then
                        self.log("the end-of-run handler failed: " .. tostring(problem))
                    end
                end
                return
            end

            -- Any error here, including a manifest write error, must not leave the runner
            -- stuck in the running state.
            local ok, err = pcall(function()
                local reason = skip_reason(self, step, request)
                if reason then
                    manifest:set(step.id, { status = "skipped", reason = reason })
                else
                    run_step(self, step, ctx, manifest)
                end
            end)
            if not ok then
                self.log("step " .. tostring(step.id) .. " could not be recorded: " .. tostring(err))
            end
            if not step.hold then
                break
            end
        end
        schedule(next_step)
    end

    local scheduled, schedule_err = schedule(next_step)
    if not scheduled then
        return nil, "could not schedule the run: " .. schedule_err
    end
    return true
end

return Runner
