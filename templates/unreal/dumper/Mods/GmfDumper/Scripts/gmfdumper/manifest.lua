-- The run manifest: one JSON file that records every step of a dump run. It is saved
-- after every change, so a game crash leaves the crashing step marked "running".

local json = require("dkjson")

local Manifest = {}
Manifest.__index = Manifest

Manifest.SCHEMA = "gmfdumper.manifest/1"
Manifest.COMPLETE_SCHEMA = "gmfdumper.run_complete/1"

local STATUSES = { pending = true, running = true, ok = true, failed = true, skipped = true }

local HEADER_ORDER = {
    "schema", "mod_version", "native_version", "game", "game_exe", "game_exe_bytes", "game_exe_link_time",
    "engine_version", "ue4ss_version",
    "map", "profile", "started", "finished", "assets_force_loaded", "steps",
}
local STEP_ORDER = { "id", "status", "seconds", "reason", "error", "files" }
local FILE_ORDER = { "path", "bytes", "count", "dir" }

local KEY_ORDER = {}
for _, list in ipairs({ HEADER_ORDER, STEP_ORDER, FILE_ORDER }) do
    for _, key in ipairs(list) do
        KEY_ORDER[#KEY_ORDER + 1] = key
    end
end

-- dkjson encodes an empty Lua table as an object unless it is marked as an array.
local function as_array(list)
    return setmetatable(list or {}, { __jsontype = "array" })
end

local function now()
    return os.date("%Y-%m-%dT%H:%M:%S")
end

function Manifest.new(fs, run_dir, header, step_ids)
    local self = setmetatable({}, Manifest)
    self.fs = fs
    self.run_dir = run_dir
    self.path = run_dir .. "\\manifest.json"
    self.data = {
        schema = Manifest.SCHEMA,
        started = now(),
        assets_force_loaded = false,
        steps = as_array({}),
    }
    for key, value in pairs(header or {}) do
        self.data[key] = value
    end
    self.index = {}
    for _, id in ipairs(step_ids) do
        local step = { id = id, status = "pending", files = as_array({}) }
        self.data.steps[#self.data.steps + 1] = step
        self.index[id] = step
    end
    local ok, err = self:save()
    if not ok then
        return nil, err
    end
    return self
end

function Manifest:save()
    local text = json.encode(self.data, { indent = true, keyorder = KEY_ORDER })
    return self.fs.write_atomic(self.path, text .. "\n")
end

function Manifest:set(step_id, fields)
    local step = self.index[step_id]
    if not step then
        error("unknown step id: " .. tostring(step_id), 2)
    end
    if fields.status and not STATUSES[fields.status] then
        error("unknown status: " .. tostring(fields.status), 2)
    end
    for key, value in pairs(fields) do
        if key == "files" then
            step.files = as_array(value)
        else
            step[key] = value
        end
    end
    return self:save()
end

function Manifest:get(step_id)
    return self.index[step_id]
end

function Manifest:header(fields)
    for key, value in pairs(fields) do
        self.data[key] = value
    end
    return self:save()
end

function Manifest:finish()
    self.data.finished = now()
    return self:save()
end

-- Counts steps by status.
function Manifest:counts()
    local counts = { pending = 0, running = 0, ok = 0, failed = 0, skipped = 0 }
    for _, step in ipairs(self.data.steps) do
        counts[step.status] = counts[step.status] + 1
    end
    return counts
end

local COMPLETE_ORDER = {
    "schema", "finished", "profile", "produced", "steps_ok", "steps_failed", "steps_skipped",
    "levels_ok", "levels_total", "native", "game_left_open",
}

-- Writes run_complete.json, the last file of a run. A reader that finds it knows that
-- every step, the level dump and the map tour have ended, whatever their result.
-- `info` has profile, levels_ok, levels_total, native and game_left_open.
function Manifest:write_run_complete(info)
    local counts = self:counts()
    local data = {
        schema = Manifest.COMPLETE_SCHEMA,
        finished = now(),
        profile = info.profile or "steps",
        produced = counts.ok > 0,
        steps_ok = counts.ok,
        steps_failed = counts.failed,
        steps_skipped = counts.skipped,
        levels_ok = info.levels_ok or 0,
        levels_total = info.levels_total or 0,
        native = info.native and true or false,
        game_left_open = info.game_left_open and true or false,
    }
    local text = json.encode(data, { indent = true, keyorder = COMPLETE_ORDER })
    return self.fs.write_atomic(self.run_dir .. "\\run_complete.json", text .. "\n")
end

return Manifest
