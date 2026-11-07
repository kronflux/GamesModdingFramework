-- hook-probe.lua: find out which of several candidate functions the game actually calls.
--
-- Why this exists (field note 18): the header dump lists functions but not who calls them.
-- When a cheat "does not work" (a protection that still lets the player be knocked down, a
-- reward that never arrives), hook every candidate on the path and log which ones fire during
-- one real occurrence.
--
-- Usage (a dev tool; remove before release):
--   local Probe = require("helpers.hook-probe")
--   Probe.watch({
--       "/Script/MyGame.PlayerComponent:HandleHazard",
--       "/Script/MyGame.BaseCharacter:Multicast_StartRagdoll",
--       "/Game/Blueprints/BP_Example.BP_Example_C:OnOverlap",     -- Blueprint: may need a retry
--   }, function(msg) print(msg .. "\n") end)
--
-- A function the engine calls natively never fires a hook (field note 4), so silence for a
-- candidate is evidence about that candidate, not proof the event did not happen. Blueprint
-- paths fail to register until their class is loaded (gotcha G14); they are retried
-- every few seconds, up to a cap. Copy paths from the object dump (G16).

local M = {}

local RETRY_MS = 3000
local MAX_TRIES = 20

-- Callbacks handed to UE4SS loops must stay referenced (field note 8). Module-level, so the
-- table and the closures in it live as long as the mod.
M.anchored = {}
local anchored = M.anchored

local function tryRegister(path, log, counts)
    local short = path:match(":(.+)$") or path
    local ok = pcall(RegisterHook, path, function()
        counts[path] = (counts[path] or 0) + 1
        log(string.format("hook-probe: %s fired (%d)", short, counts[path]))
    end)
    return ok
end

---Hook each path and log every call. Returns the counts table (path -> calls so far).
---@param paths string[]
---@param log fun(msg: string)|nil defaults to print
---@return table counts
function M.watch(paths, log)
    log = log or function(msg) print(msg .. "\n") end
    local counts, pending = {}, {}
    if type(RegisterHook) ~= "function" then
        log("hook-probe: RegisterHook is unavailable")
        return counts
    end

    for _, p in ipairs(paths) do
        if not tryRegister(p, log, counts) then pending[#pending + 1] = p end
    end
    log(string.format("hook-probe: watching %d of %d", #paths - #pending, #paths))

    if #pending > 0 and type(LoopInGameThreadWithDelay) == "function" then
        local tries = 0
        local loop
        local handle = nil -- from LoopInGameThreadWithDelay, needed to cancel the loop
        loop = function()
            tries = tries + 1
            local still = {}
            for _, p in ipairs(pending) do
                if tryRegister(p, log, counts) then
                    log("hook-probe: registered late: " .. p)
                else
                    still[#still + 1] = p
                end
            end
            pending = still
            if #pending == 0 or tries >= MAX_TRIES then
                for _, p in ipairs(pending) do log("hook-probe: gave up on " .. p) end
                anchored[loop] = nil
                -- The loop's return value is ignored by UE4SS; only
                -- CancelDelayedAction stops a LoopInGameThreadWithDelay.
                if handle ~= nil and type(CancelDelayedAction) == "function" then
                    pcall(CancelDelayedAction, handle)
                end
            end
        end
        anchored[loop] = true
        local okLoop, result = pcall(LoopInGameThreadWithDelay, RETRY_MS, loop)
        if okLoop then
            handle = result
        else
            anchored[loop] = nil
            log("hook-probe: could not start the retry loop: " .. tostring(result))
        end
    end
    return counts
end

return M
