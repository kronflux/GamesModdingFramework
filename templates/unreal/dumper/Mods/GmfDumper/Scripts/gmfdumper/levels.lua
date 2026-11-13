-- The level dump: loads each of the game's maps as data and writes the actors saved in
-- it. The game does not travel to the map, so none of the game's own code runs for it:
-- no game mode, no loading screen, no BeginPlay. That is what makes this safe on maps
-- that cannot be opened on their own.
--
-- What it shows is the level as built: every placed actor with its transform, components
-- and property values. Actors the game spawns while a match runs are not in a map file.
--
-- It works in two parts. Maps that are in memory during the main run are written then,
-- by the step levels_loaded (dump_loaded): a map the game or the asset load brought in
-- can be gone, and not loadable a second time, once the run releases its assets. The
-- other maps are loaded one at a time after the run (start), with a garbage collection
-- between them.

local json = require("dkjson")

local Levels = {}
Levels.__index = Levels

local function lower_contains(text, words)
    local lowered = text:lower()
    for _, word in ipairs(words or {}) do
        if lowered:find(word:lower(), 1, true) then
            return word
        end
    end
    return nil
end

-- "/Game/Maps/Lobby" from "/Game/Maps/Lobby.Lobby".
local function package_of(path)
    return (path:match("^([^.]+)") or path)
end

local function folder_name(path)
    local name = package_of(path):match("([^/]+)$") or "Map"
    return (name:gsub('[<>:"/\\|%?%*%%!]', "_"))
end

-- options: api, native, fs, config (the levels table), min_free_mb, log, after(seconds, fn)
function Levels.new(options)
    local self = setmetatable({}, Levels)
    for key, value in pairs(options) do
        self[key] = value
    end
    return self
end

-- The maps to dump, in order. `maps` in the config is "auto" or a list of map paths.
-- "auto" takes every map the asset registry lists outside the engine's own content whose
-- path has none of the excluded words.
function Levels:plan()
    local maps = {}
    local wanted = self.config.maps
    if type(wanted) == "table" then
        for _, path in ipairs(wanted) do
            maps[#maps + 1] = package_of(path)
        end
        return maps
    end
    local listing = self.native and self.native.ListMaps and select(2, pcall(self.native.ListMaps))
    if type(listing) ~= "string" then
        return maps
    end
    for line in listing:gmatch("[^\r\n]+") do
        local package = package_of(line)
        if not package:lower():find("^/engine/") and not lower_contains(package, self.config.exclude) then
            maps[#maps + 1] = package
        end
    end
    table.sort(maps)
    return maps
end

function Levels:save()
    local document = {
        schema = "gmfdumper.levels/1",
        note = "Each map was read as data, without travelling to it. Its files are in Levels/<folder>: "
            .. "the actors saved in the map, not the ones a running match spawns.",
        maps = setmetatable(self.results, { __jsontype = "array" }),
    }
    self.fs.write_atomic(self.run_dir .. "\\Levels\\levels.json",
        json.encode(document, { indent = true, keyorder = { "schema", "note", "maps", "map", "folder", "status", "actors", "error", "files", "path", "bytes" } }) .. "\n")
end

function Levels:begin(run_dir)
    if self.run_dir == run_dir and self.results then
        return
    end
    self.run_dir = run_dir
    self.results = {}
    self.by_map = {}
    self.used_folders = {}
end

function Levels:unique_folder(map)
    local base = folder_name(map)
    local name, n = base, 1
    while self.used_folders[name:lower()] do
        n = n + 1
        name = base .. "_" .. n
    end
    self.used_folders[name:lower()] = true
    return name
end

-- Writes one map and records the result. A map tried before keeps its entry and folder.
function Levels:dump_one(map, min_free_mb)
    local result = self.by_map[map]
    if not result then
        result = { map = map, folder = "Levels/" .. self:unique_folder(map) }
        self.results[#self.results + 1] = result
        self.by_map[map] = result
    end
    result.status, result.error, result.actors, result.files = "running", nil, nil, nil
    self.fs.mkdirs(self.run_dir .. "\\Levels")
    -- Recorded before the map is read: if the game dies on it, the file says which.
    self:save()

    local dir = self.run_dir .. "\\" .. result.folder:gsub("/", "\\")
    local called, count, err = pcall(self.native.DumpLevel, map, dir, min_free_mb)
    if called and count then
        result.status = "ok"
        result.actors = tonumber(count) or 0
        local files = {}
        for _, name in ipairs({ "actors.json", "actor_values.jsonl" }) do
            local bytes = self.fs.size(dir .. "\\" .. name)
            if bytes and bytes >= 0 then
                files[#files + 1] = { path = result.folder .. "/" .. name, bytes = bytes }
            end
        end
        result.files = setmetatable(files, { __jsontype = "array" })
        self.log(string.format("levels: %s ok, %d actors", map, result.actors))
    else
        result.status = "failed"
        result.error = tostring(called and err or count)
        self.log("levels: " .. map .. " failed: " .. result.error)
    end
    self:save()
    return result
end

-- Writes the maps of the plan that are in memory right now, all in this one call.
-- Returns the level files written, for the manifest.
function Levels:dump_loaded(run_dir)
    self:begin(run_dir)
    local files = {}
    local listing = self.native and self.native.ListLoadedMaps and select(2, pcall(self.native.ListLoadedMaps))
    if type(listing) ~= "string" then
        return files
    end
    local in_memory = {}
    for line in listing:gmatch("[^\r\n]+") do
        in_memory[package_of(line)] = true
    end
    -- Levels/levels.json is not among the files reported: it grows when the other maps
    -- are added after the run, and the manifest records sizes as they were at this point.
    for _, map in ipairs(self:plan()) do
        if in_memory[map] then
            local result = self:dump_one(map, 0)
            for _, file in ipairs(result.files or {}) do
                files[#files + 1] = file
            end
        end
    end
    return files
end

-- Asks the engine to collect garbage on its next tick, so the map just released, and the
-- meshes and textures it brought with it, leave memory before the next map is loaded.
function Levels:collect_garbage()
    pcall(function()
        self.api.StaticFindObject("/Script/Engine.Default__KismetSystemLibrary"):CollectGarbage()
    end)
end

-- Loads and writes the maps not written yet. `on_done` is called once, after the last.
function Levels:start(run_dir, on_done)
    self:begin(run_dir)
    self.on_done = on_done
    self.queue = {}
    for _, map in ipairs(self:plan()) do
        local earlier = self.by_map[map]
        if not (earlier and earlier.status == "ok") then
            self.queue[#self.queue + 1] = map
        end
    end
    if #self.queue == 0 and #self.results == 0 then
        self.log("levels: no maps to load")
        on_done()
        return
    end
    self.log("levels: " .. #self.queue .. " maps to load as data")
    self.index = 0
    self:next_map()
end

function Levels:next_map()
    -- A loop, not recursion: without timers every map runs in this one call.
    while true do
        self.index = self.index + 1
        local map = self.queue[self.index]
        if not map then
            local ok = 0
            for _, result in ipairs(self.results) do
                ok = ok + (result.status == "ok" and 1 or 0)
            end
            self.log(string.format("levels finished: %d of %d maps dumped", ok, #self.results))
            self.on_done()
            return
        end
        self:dump_one(map, self.min_free_mb)
        self:collect_garbage()
        if self.after(self.config.pause_seconds, function() self:next_map() end) then
            return
        end
    end
end

return Levels
