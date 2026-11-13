-- The map tour: after the main run, opens each of the game's maps in turn and dumps the
-- level it finds there. The main run describes one level, the one that happened to be
-- loaded; this adds the others without the user playing through to each.
--
-- A map opened this way loads without the session a host would create, so a game mode
-- that expects one may misbehave. The tour therefore runs last, when every other dump is
-- on disk, and records each map before it is opened, so a crash names the map.

local json = require("dkjson")

local Tour = {}
Tour.__index = Tour

local POLL_SECONDS = 2

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

-- A folder name for a map: its last path part, made safe for Windows.
local function folder_name(path)
    local name = package_of(path):match("([^/]+)$") or "Map"
    return (name:gsub('[<>:"/\\|%?%*%%!]', "_"))
end

-- options: api, native, fs, config (the map_tour table), log, after(seconds, fn),
-- world_steps (list of steps), make_context(world_folder), controller() -> object or nil,
-- crash_file (optional path of the list of maps that ended the game)
function Tour.new(options)
    local self = setmetatable({}, Tour)
    for key, value in pairs(options) do
        self[key] = value
    end
    return self
end

-- The maps to visit, in order. `maps` in the config is "auto" or a list of map paths.
-- "auto" takes every map the asset registry lists that lies in a folder named Maps,
-- outside the engine's own content, and whose path has none of the excluded words.
function Tour:plan()
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
    for line in listing:gmatch("[^\n]+") do
        local package = package_of(line)
        local lowered = package:lower()
        if lowered:find("/maps/", 1, true) and not lowered:find("^/engine/") and not lower_contains(package, self.config.exclude) then
            maps[#maps + 1] = package
        end
    end
    table.sort(maps)
    return maps
end

function Tour:save()
    local document = {
        schema = "gmfdumper.map_tour/1",
        note = "Each map was opened without a game session. Its files are in World/<folder>.",
        maps = setmetatable(self.results, { __jsontype = "array" }),
    }
    self.fs.write_atomic(self.run_dir .. "\\World\\map_tour.json",
        json.encode(document, { indent = true, keyorder = { "schema", "note", "maps", "map", "folder", "status", "seconds", "error", "files", "path", "bytes" } }) .. "\n")
end

-- Some maps end the game when they are opened without a session: the game's own code
-- fails, in a way no Lua error handler sees. So the map about to be opened is written to
-- "<crash_file>.opening", outside the run folder, and cleared when the map is finished.
-- A name still there at the next start is a map that ended the game; it moves to the
-- crash list and is not opened again. Deleting the crash list makes the tour try again.
function Tour:mark_opening(map)
    if self.crash_file then
        pcall(self.fs.write_atomic, self.crash_file .. ".opening", map)
    end
end

function Tour:load_crashed()
    self.crashed = {}
    if not self.crash_file then
        return
    end
    local listed = self.fs.read(self.crash_file) or ""
    for line in listed:gmatch("[^\r\n]+") do
        self.crashed[line] = true
    end
    local opening = self.fs.read(self.crash_file .. ".opening")
    opening = opening and opening:match("^%s*(.-)%s*$") or ""
    if opening ~= "" and not self.crashed[opening] then
        self.crashed[opening] = true
        pcall(self.fs.write_atomic, self.crash_file, listed .. opening .. "\n")
        self.log("map tour: the game ended while opening " .. opening .. " in an earlier run; it will be skipped")
    end
    self:mark_opening("")
end

function Tour:current_map()
    if not (self.native and self.native.MapName) then
        return nil
    end
    local ok, map = pcall(self.native.MapName)
    return ok and map or nil
end

-- Starts the tour. `on_done` is called once, when the last map is finished or skipped.
function Tour:start(run_dir, on_done)
    self.run_dir = run_dir
    self.on_done = on_done
    self.results = {}
    -- The map the main run just dumped. It is compared with this, not with the map loaded
    -- at the time, because by then the tour has moved the game somewhere else.
    local start_map = self:current_map()
    self.start_map = start_map and package_of(start_map) or nil
    self.queue = self:plan()
    self:load_crashed()
    if #self.queue == 0 then
        self.log("map tour: no maps to visit")
        on_done()
        return
    end
    self.fs.mkdirs(run_dir .. "\\World")
    self.log("map tour: " .. #self.queue .. " maps to visit")
    self.index = 0
    self:next_map()
end

function Tour:next_map()
    self.index = self.index + 1
    local map = self.queue[self.index]
    if not map then
        self:save()
        local ok = 0
        for _, result in ipairs(self.results) do
            ok = ok + (result.status == "ok" and 1 or 0)
        end
        self.log(string.format("map tour finished: %d of %d maps dumped", ok, #self.results))
        self.on_done()
        return
    end

    local result = { map = map, folder = "World/" .. folder_name(map), status = "running" }
    self.results[#self.results + 1] = result
    self.current = result

    if map == self.start_map then
        result.status = "skipped"
        result.error = "already dumped by the main run in World/"
        self:save()
        return self:next_map()
    end

    if self.crashed[map] then
        result.status = "skipped"
        result.error = "the game crashed opening this map in an earlier run; delete map_tour_crashed.txt in the mod folder to try it again"
        self:save()
        return self:next_map()
    end

    -- Recorded before the map is opened: if the game dies loading it, the file says which.
    self:save()
    self:mark_opening(map)
    self.log("map tour: opening " .. map)
    local opened, err = pcall(function()
        local statics = self.api.StaticFindObject("/Script/Engine.Default__GameplayStatics")
        local context = self.controller()
        if not context then
            error("no local player controller to open the map from")
        end
        -- OpenLevel(WorldContextObject, LevelName, bAbsolute, Options)
        statics:OpenLevel(context, self.api.FName(map), true, "")
    end)
    if not opened then
        return self:finish_map("failed", "could not open the map: " .. tostring(err))
    end
    self.started = self.clock()
    self.waited = 0
    self.stable = 0
    self.seen = false
    self:wait_for_map()
end

function Tour:finish_map(status, err, files)
    local result = self.current
    result.status = status
    result.error = err
    result.files = files and setmetatable(files, { __jsontype = "array" }) or nil
    if self.started then
        result.seconds = math.floor((self.clock() - self.started) * 10 + 0.5) / 10
    end
    self.started = nil
    self:mark_opening("")
    self:save()
    self.log("map tour: " .. result.map .. " " .. status .. (err and (": " .. err) or ""))
    self:next_map()
end

-- Polls until the wanted map is the one the local player is in and has stayed so for
-- settle_seconds, then dumps it. Gives up after max_wait_seconds.
function Tour:wait_for_map()
    local wanted = self.current.map
    local now = self:current_map()
    local arrived = now ~= nil and package_of(now) == wanted
    -- The time settled counts from the first check that saw the map.
    if arrived and self.seen then
        self.stable = self.stable + POLL_SECONDS
    else
        self.stable = 0
    end
    self.seen = arrived
    if arrived and self.stable >= self.config.settle_seconds then
        return self:dump_map()
    end
    if self.waited >= self.config.max_wait_seconds then
        return self:finish_map("failed", "the map did not finish loading in " .. tostring(self.config.max_wait_seconds)
            .. " seconds; the game is on " .. tostring(now))
    end
    self.waited = self.waited + POLL_SECONDS
    local scheduled = self.after(POLL_SECONDS, function() self:wait_for_map() end)
    if not scheduled then
        self:finish_map("failed", "could not schedule the next check")
    end
end

-- Runs the world steps for the map that is loaded now, all in this one call, so the game
-- gets no tick between them and the files describe the same moment.
function Tour:dump_map()
    local folder = self.current.folder:gsub("/", "\\")
    local ctx = self.make_context(folder)
    local files, errors = {}, {}
    for _, step in ipairs(self.world_steps) do
        if not (step.needs_native and not self.native) then
            local results = table.pack(pcall(step.run, ctx))
            if results[1] and type(results[2]) == "table" then
                for _, file in ipairs(results[2]) do
                    files[#files + 1] = file
                end
            elseif results[2] ~= "skip" then
                errors[#errors + 1] = step.id .. ": " .. tostring(results[1] and results[3] or results[2])
            end
        end
    end
    if #files == 0 then
        return self:finish_map("failed", table.concat(errors, "; "))
    end
    self:finish_map("ok", #errors > 0 and table.concat(errors, "; ") or nil, files)
end

return Tour
