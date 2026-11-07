-- session-log.lua: an append-only log in the mod's own folder that survives relaunches.
--
-- Why this exists (field note 15): UE4SS rewrites UE4SS.log on every launch, so a test
-- session's results are gone as soon as the game restarts. This file keeps them, with a dated
-- header per session, rotated to one ".old" file past a size cap.
--
-- Usage:
--   local Log = require("helpers.session-log")
--   Log.start("MyMod-session.log")          -- once, at mod load
--   Log.line("spawn: Spawned 1 x medkit")    -- also prints to UE4SS.log
--
-- The path comes from this file's own location (debug.getinfo), never a relative io.open path,
-- which resolves against Binaries/Win64 (gotcha G1).

local M = {}

local MAX_BYTES = 1024 * 1024
local path = nil

-- <mod>/Scripts/helpers/session-log.lua -> <mod>/
local function modDir()
    local info = debug.getinfo(1, "S")
    local src = (info and info.source or ""):gsub("^@", "")
    local dir = src:match("^(.*[/\\])[Ss]cripts[/\\]")
    return dir
end

local function append(text)
    if path == nil then return end
    local f = io.open(path, "a")
    if f == nil then return end
    f:write(tostring(os.date("%Y-%m-%d %H:%M:%S ")), text, "\n")
    f:close()
end

---Open (or rotate) the log and write a session header.
---@param fileName string e.g. "MyMod-session.log"
---@return string|nil path the full path, or nil when the mod folder could not be found
function M.start(fileName)
    local dir = modDir()
    if dir == nil then return nil end
    path = dir .. fileName

    local f = io.open(path, "r")
    if f ~= nil then
        local size = f:seek("end") or 0
        f:close()
        if size > MAX_BYTES then
            os.remove(path .. ".old")
            os.rename(path, path .. ".old")
        end
    end
    append("==== session start ====")
    return path
end

---Write one line to the session log and to UE4SS.log.
---@param text string
function M.line(text)
    text = tostring(text)
    print(text .. "\n")
    append(text)
end

return M
