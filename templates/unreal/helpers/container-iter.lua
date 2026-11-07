-- container-iter.lua: iterate a TArray, a TMap or a plain Lua table the same way.
--
-- Verified in play (field note 25) on a TMap<Enum, Actor*> property and a TArray<Struct>
-- property: elements arrive wrapped and need :get(); some builds hand plain values, hence the
-- fallback. Struct elements are then read with plain indexing (elem.FieldName).
--
-- Usage:
--   local Iter = require("helpers.container-iter")
--   Iter.each(someSubsystem.ActiveItems, function(item) ... end)    -- TMap: values
--   Iter.each(quest.QuestObjectives, function(obj) print(obj.CurrentValue) end)
--   local list = Iter.list(someActor:GetSomeArray())                   -- into a Lua table
--
-- A struct element may be a copy (field note 12, gotcha G26): to change one, write
-- it back with elem:set(value) or reassign the whole property, then read it back.

local M = {}

---Calls fn(value) for each element. For a TMap, fn receives the value; use eachPair for keys.
---@param container any
---@param fn fun(value: any)
function M.each(container, fn)
    if container == nil then return end
    if type(container) == "table" then
        for _, v in ipairs(container) do fn(v) end
        return
    end
    -- A container that cannot be iterated is skipped, but an error raised by fn
    -- is kept and re-raised after the loop so the caller sees it.
    local callbackError = nil
    pcall(function()
        container:ForEach(function(a, b)
            if callbackError ~= nil then return true end -- stop after a failed callback
            local raw = (b ~= nil) and b or a  -- TMap: key, value. TArray: index, element.
            local ok, inner = pcall(function() return raw:get() end)
            local okFn, err
            if ok then
                okFn, err = pcall(fn, inner)
            else
                okFn, err = pcall(fn, raw)
            end
            if not okFn then callbackError = err or "callback failed" end
        end)
    end)
    if callbackError ~= nil then error(callbackError, 0) end
end

---Calls fn(key, value) for each TMap entry, both unwrapped.
---@param map any
---@param fn fun(key: any, value: any)
function M.eachPair(map, fn)
    if map == nil then return end
    local callbackError = nil
    pcall(function()
        map:ForEach(function(k, v)
            if callbackError ~= nil then return true end -- stop after a failed callback
            local okK, key = pcall(function() return k:get() end)
            local okV, val = pcall(function() return v:get() end)
            if not okK then key = k end
            if not okV then val = v end
            local okFn, err = pcall(fn, key, val)
            if not okFn then callbackError = err or "callback failed" end
        end)
    end)
    if callbackError ~= nil then error(callbackError, 0) end
end

---The elements as a plain Lua array.
---@param container any
---@return table
function M.list(container)
    local out = {}
    M.each(container, function(v) out[#out + 1] = v end)
    return out
end

return M
