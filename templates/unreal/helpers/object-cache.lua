-- object-cache.lua: keep a live list of a class's instances without searching every tick.
--
-- Why this exists (field note 16): FindAllOf and FindFirstOf walk the whole object array on
-- every call. On a 20 Hz tick, a few of them drop the frame rate. This
-- seeds the list once and keeps it current through NotifyOnNewObject, dropping dead entries as
-- they are read.
--
-- Usage:
--   local Cache = require("helpers.object-cache")
--   local actors = Cache.track("/Script/MyGame.ExampleActor")   -- once, at mod load
--   -- on the tick:
--   for _, actor in ipairs(actors:live()) do ... end
--
-- Only for classes that exist when the mod loads: native "/Script/..." classes always do. A
-- Blueprint class ("/Game/.../BP_X.BP_X_C") that is not loaded yet cannot be registered; search
-- for that one rarely instead. FindAllOf also returns instances from loaded worlds nobody is
-- playing in (field note 5): filter the live list by world before acting on it.
-- Register each class once per mod (NotifyOnNewObject's own rule).

local M = {}

local function valid(o)
    if o == nil then return false end
    local ok, v = pcall(function() return o:IsValid() end)
    return ok and v == true
end

local Tracker = {}
Tracker.__index = Tracker

---Valid instances, with dead ones removed from the list.
---@return table[]
function Tracker:live()
    local keep = {}
    for _, o in ipairs(self.items) do
        if valid(o) then keep[#keep + 1] = o end
    end
    self.items = keep
    return keep
end

---@param classPath string "/Script/Module.Class"
---@return table tracker with :live()
function M.track(classPath)
    local t = setmetatable({ items = {}, classPath = classPath }, Tracker)

    -- Seed once with what already exists (a mod reload mid-match).
    local short = classPath:match("[%.:]([^%.:]+)$") or classPath
    local okAll, all = pcall(FindAllOf, short)
    if okAll and type(all) == "table" then
        for _, o in ipairs(all) do t.items[#t.items + 1] = o end
    end

    if type(NotifyOnNewObject) == "function" then
        -- Types.lua declares the callback with no parameters; UE4SS passes the new object.
        ---@diagnostic disable-next-line: redundant-parameter
        local okNotify, notifyErr = pcall(NotifyOnNewObject, classPath, function(...)
            local o = ...
            if o ~= nil then t.items[#t.items + 1] = o end
        end)
        if not okNotify then
            -- Without the registration the list is never updated beyond the seed.
            print("[object-cache] NotifyOnNewObject('" .. classPath .. "') failed: " .. tostring(notifyErr) .. "\n")
        end
    end
    return t
end

return M
