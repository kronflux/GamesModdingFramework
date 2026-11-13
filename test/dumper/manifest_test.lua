local Fs = require("gmfdumper.fs")
local Manifest = require("gmfdumper.manifest")
local json = require("dkjson")

local tests = {}

local function load(t, dir)
    local text = t.support.read(dir .. "\\manifest.json")
    t:ok(text, "manifest.json exists")
    local data, _, err = json.decode(text)
    t:ok(data, "manifest decodes: " .. tostring(err))
    return data
end

local function by_id(data)
    local map = {}
    for _, step in ipairs(data.steps) do
        map[step.id] = step
    end
    return map
end

function tests.new_manifest_lists_every_step_pending(t)
    local dir = t.support.temp_dir("man")
    local m = Manifest.new(Fs.new(nil), dir, { game = "G", profile = "full" }, { "a", "b", "c" })
    t:ok(m)
    local data = load(t, dir)
    t:eq(data.schema, "gmfdumper.manifest/1")
    t:eq(data.game, "G")
    t:eq(#data.steps, 3)
    t:eq(data.steps[1].id, "a", "order kept")
    t:eq(data.steps[3].status, "pending")
    t:eq(data.assets_force_loaded, false)
    t:eq(data.finished, nil, "not finished yet")
end

function tests.set_saves_each_change(t)
    local dir = t.support.temp_dir("man")
    local m = Manifest.new(Fs.new(nil), dir, {}, { "a", "b" })
    m:set("a", { status = "running" })
    t:eq(by_id(load(t, dir)).a.status, "running")
    m:set("a", { status = "ok", seconds = 1.5, files = { { path = "A/x.txt", bytes = 3 } } })
    local a = by_id(load(t, dir)).a
    t:eq(a.status, "ok")
    t:eq(a.seconds, 1.5)
    t:eq(a.files[1].path, "A/x.txt")
    t:eq(a.files[1].bytes, 3)
end

function tests.failed_and_skipped_carry_text(t)
    local dir = t.support.temp_dir("man")
    local m = Manifest.new(Fs.new(nil), dir, {}, { "a", "b" })
    m:set("a", { status = "failed", error = "boom" })
    m:set("b", { status = "skipped", reason = "native unavailable" })
    local map = by_id(load(t, dir))
    t:eq(map.a.error, "boom")
    t:eq(map.b.reason, "native unavailable")
end

function tests.unknown_step_or_status_is_an_error(t)
    local dir = t.support.temp_dir("man")
    local m = Manifest.new(Fs.new(nil), dir, {}, { "a" })
    t:no(pcall(m.set, m, "zzz", { status = "ok" }), "unknown step")
    t:no(pcall(m.set, m, "a", { status = "done" }), "unknown status")
end

function tests.header_and_finish(t)
    local dir = t.support.temp_dir("man")
    local m = Manifest.new(Fs.new(nil), dir, {}, { "a" })
    m:header({ assets_force_loaded = true, map = "/Game/Maps/X" })
    m:finish()
    local data = load(t, dir)
    t:eq(data.assets_force_loaded, true)
    t:eq(data.map, "/Game/Maps/X")
    t:ok(data.finished, "finished time set")
end

function tests.empty_files_list_is_a_json_array(t)
    local dir = t.support.temp_dir("man")
    local m = Manifest.new(Fs.new(nil), dir, {}, { "a" })
    m:set("a", { status = "ok", files = {} })
    local text = t.support.read(dir .. "\\manifest.json")
    t:ok(text:find('"files"%s*:%s*%[%s*%]'), "files encodes as []")
end

-- AC-5: a process that dies inside a step leaves a readable manifest.
function tests.crash_inside_a_step_leaves_a_readable_manifest(t)
    local dir = t.support.temp_dir("crash")
    local script = dir .. "\\crash.lua"
    local root = t.mod:gsub("\\", "/")
    t.support.write(script, string.format([[
package.path = "%s/Scripts/?.lua;%s/Scripts/vendor/?.lua;" .. package.path
local Fs = require("gmfdumper.fs")
local Manifest = require("gmfdumper.manifest")
local m = Manifest.new(Fs.new(nil), %q, {}, { "first", "second", "third" })
m:set("first", { status = "running" })
m:set("first", { status = "ok", files = {} })
m:set("second", { status = "running" })
os.exit(3, false)
]], root, root, dir))
    os.execute('lua "' .. script .. '"')
    local map = by_id(load(t, dir))
    t:eq(map.first.status, "ok")
    t:eq(map.second.status, "running")
    t:eq(map.third.status, "pending")
end

return tests
