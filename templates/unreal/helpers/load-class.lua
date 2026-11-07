-- load-class.lua: resolve a UClass from a path, loading it if needed, without crashing.
--
-- Why this exists (field note 13): passing a Lua string to a UFunction whose parameter is a
-- soft pointer (KismetSystemLibrary:LoadClassAsset_Blocking takes TSoftClassPtr) crashes the
-- game inside UE4SS's push_softobjectproperty. Only classes not yet in memory reach the load
-- step, so the crash looks like "these particular items crash". Use UE4SS's own LoadAsset.
--
-- Usage:
--   local LoadClass = require("helpers.load-class")
--   local cls, why = LoadClass.resolve("/Game/Path/BP_Thing.BP_Thing_C")
--   if cls == nil then print(why) end
--
-- Game thread only (LoadAsset's own rule): call it from a console handler, a keybind body
-- wrapped in ExecuteInGameThread, or a LoopInGameThreadWithDelay callback.

local M = {}

local function valid(o)
    if o == nil then return false end
    local ok, v = pcall(function() return o:IsValid() end)
    return ok and v == true
end

---@param path string "/Game/.../BP_X.BP_X_C" for a Blueprint class, "/Script/Module.Class" for native
---@return any|nil cls
---@return string|nil reason set when cls is nil
function M.resolve(path)
    if type(path) ~= "string" or path == "" then return nil, "no class path given" end

    -- Already in memory: Blueprint classes that are placed in the level, and every native class.
    local okFind, found = pcall(StaticFindObject, path)
    if okFind and valid(found) then return found, nil end

    if path:sub(1, 8) == "/Script/" then
        return nil, "native class '" .. path .. "' is not loaded (an asset loader cannot load it)"
    end
    if type(LoadAsset) ~= "function" then
        return nil, "'" .. path .. "' is not loaded, and this UE4SS build has no LoadAsset"
    end

    -- The asset is the Blueprint "<pkg>.BP_X"; its generated class is "<pkg>.BP_X_C".
    local assetPath = path:gsub("_C$", "")
    local okLoad, err = pcall(LoadAsset, assetPath)
    if not okLoad then return nil, "LoadAsset('" .. assetPath .. "') raised: " .. tostring(err) end

    local okAgain, cls = pcall(StaticFindObject, path)
    if okAgain and valid(cls) then return cls, nil end
    return nil, "'" .. path .. "' did not resolve after LoadAsset (wrong path, or stale after a game update)"
end

---Same as resolve, for a data asset (not a class): "/Game/.../DA_X.DA_X".
---@param path string
---@return any|nil obj
---@return string|nil reason
function M.asset(path)
    if type(path) ~= "string" or path == "" then return nil, "no asset path given" end
    local okFind, found = pcall(StaticFindObject, path)
    if okFind and valid(found) then return found, nil end
    if type(LoadAsset) ~= "function" then return nil, "this UE4SS build has no LoadAsset" end
    pcall(LoadAsset, path)
    local okAgain, obj = pcall(StaticFindObject, path)
    if okAgain and valid(obj) then return obj, nil end
    return nil, "'" .. path .. "' could not be found or loaded"
end

return M
