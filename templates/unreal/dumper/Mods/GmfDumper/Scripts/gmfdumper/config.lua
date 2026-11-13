-- Loads config.lua and replaces every missing or invalid value with its default.

local Steps = require("gmfdumper.steps")

local Config = {}

Config.DEFAULTS = {
    default_profile = "full",
    keybind = { key = "NUM_ZERO", modifiers = { "CONTROL" } },
    output_root = "Dumps",
    include_blueprint_types = true,
    jmap_skip_property_values = false,
    bpsdk_backend = "UE4SS",
    also_write_shared_lua_types = true,
    disabled_steps = {},
    auto_run = {
        mode = "once", delay_seconds = 15, freeze_input = true, quit_when_done = true,
        settle_seconds = 10, max_wait_seconds = 300, wait_for_map = "",
        skip_maps = { "shader", "loading", "startup", "splash", "intro", "logo" },
    },
    load_assets = { mode = "data", min_free_memory_gb = 1.5 },
    levels = { enabled = true, maps = "auto", exclude = {}, pause_seconds = 1 },
    map_tour = {
        enabled = false, maps = "auto", settle_seconds = 6, max_wait_seconds = 180,
        exclude = { "developers", "mockup", "shader", "loading", "startup", "splash", "intro", "logo", "entry", "scene" },
    },
}

local LOAD_MODES = { data = true, all = true }

local PROFILES = { full = true, quick = true }
local AUTO_MODES = { once = true, always = true, off = true }

local function copy(value)
    if type(value) ~= "table" then
        return value
    end
    local out = {}
    for key, item in pairs(value) do
        out[key] = copy(item)
    end
    return out
end

-- Validates a table that was already loaded. `keys` and `modifier_keys` are the UE4SS
-- Key and ModifierKey tables; when given, key names are checked against them.
function Config.validate(loaded, keys, modifier_keys)
    local config = copy(Config.DEFAULTS)
    local warnings = {}
    local function warn(message)
        warnings[#warnings + 1] = message
    end

    if type(loaded) ~= "table" then
        if loaded ~= nil then
            warn("config.lua did not return a table; using defaults")
        end
        config.warnings = warnings
        return config
    end

    for key, value in pairs(loaded) do
        local default = Config.DEFAULTS[key]
        if default == nil then
            warn("unknown setting ignored: " .. tostring(key))
        elseif type(value) ~= type(default) then
            warn(string.format("%s must be a %s; using the default", key, type(default)))
        else
            config[key] = copy(value)
        end
    end

    if not PROFILES[config.default_profile] then
        warn('default_profile must be "full" or "quick"; using "full"')
        config.default_profile = "full"
    end

    if config.output_root == "" then
        warn("output_root is empty; using Dumps")
        config.output_root = "Dumps"
    end

    local known = {}
    for _, id in ipairs(Steps.ORDER) do
        known[id] = true
    end
    local disabled = {}
    for _, id in ipairs(config.disabled_steps) do
        if known[id] then
            disabled[#disabled + 1] = id
        else
            warn("unknown step in disabled_steps ignored: " .. tostring(id))
        end
    end
    config.disabled_steps = disabled

    local bind = config.keybind
    local default_bind = Config.DEFAULTS.keybind
    if type(bind.key) ~= "string" or (keys and keys[bind.key] == nil) then
        warn("keybind.key is not a known key; using " .. default_bind.key)
        bind.key = default_bind.key
    end
    if type(bind.modifiers) ~= "table" then
        bind.modifiers = copy(default_bind.modifiers)
    end
    local modifiers = {}
    for _, name in ipairs(bind.modifiers) do
        if type(name) == "string" and (not modifier_keys or modifier_keys[name] ~= nil) then
            modifiers[#modifiers + 1] = name
        else
            warn("unknown keybind modifier ignored: " .. tostring(name))
        end
    end
    bind.modifiers = modifiers

    -- auto_run: each field falls back on its own, so a partial table is fine.
    local auto = config.auto_run
    local default_auto = Config.DEFAULTS.auto_run
    for key in pairs(auto) do
        if default_auto[key] == nil then
            warn("unknown auto_run setting ignored: " .. tostring(key))
            auto[key] = nil
        end
    end
    if auto.mode == nil then
        auto.mode = default_auto.mode
    elseif not AUTO_MODES[auto.mode] then
        -- An unreadable mode must not start a run that closes the game.
        warn('auto_run.mode must be "once", "always" or "off"; using "off"')
        auto.mode = "off"
    end
    if auto.delay_seconds == nil then
        auto.delay_seconds = default_auto.delay_seconds
    elseif type(auto.delay_seconds) ~= "number" or auto.delay_seconds < 0 or auto.delay_seconds > 3600 then
        warn("auto_run.delay_seconds must be a number from 0 to 3600; using " .. default_auto.delay_seconds)
        auto.delay_seconds = default_auto.delay_seconds
    end
    for _, key in ipairs({ "settle_seconds", "max_wait_seconds" }) do
        if auto[key] == nil then
            auto[key] = default_auto[key]
        elseif type(auto[key]) ~= "number" or auto[key] < 0 or auto[key] > 3600 then
            warn("auto_run." .. key .. " must be a number from 0 to 3600; using " .. default_auto[key])
            auto[key] = default_auto[key]
        end
    end
    if auto.wait_for_map == nil then
        auto.wait_for_map = default_auto.wait_for_map
    elseif type(auto.wait_for_map) ~= "string" then
        warn('auto_run.wait_for_map must be text; using ""')
        auto.wait_for_map = default_auto.wait_for_map
    end
    if auto.skip_maps == nil then
        auto.skip_maps = copy(default_auto.skip_maps)
    elseif type(auto.skip_maps) ~= "table" then
        warn("auto_run.skip_maps must be a list of text; using the default list")
        auto.skip_maps = copy(default_auto.skip_maps)
    else
        local kept = {}
        for _, entry in ipairs(auto.skip_maps) do
            if type(entry) == "string" and entry ~= "" then
                kept[#kept + 1] = entry:lower()
            else
                warn("auto_run.skip_maps entry ignored: " .. tostring(entry))
            end
        end
        auto.skip_maps = kept
    end

    -- load_assets
    local load = config.load_assets
    local default_load = Config.DEFAULTS.load_assets
    for key in pairs(load) do
        if default_load[key] == nil then
            warn("unknown load_assets setting ignored: " .. tostring(key))
            load[key] = nil
        end
    end
    if load.mode == nil then
        load.mode = default_load.mode
    elseif not LOAD_MODES[load.mode] then
        warn('load_assets.mode must be "data" or "all"; using "data"')
        load.mode = default_load.mode
    end
    if load.min_free_memory_gb == nil then
        load.min_free_memory_gb = default_load.min_free_memory_gb
    elseif type(load.min_free_memory_gb) ~= "number" or load.min_free_memory_gb < 0 or load.min_free_memory_gb > 1024 then
        warn("load_assets.min_free_memory_gb must be a number from 0 to 1024; using " .. default_load.min_free_memory_gb)
        load.min_free_memory_gb = default_load.min_free_memory_gb
    end

    -- levels
    local levels = config.levels
    local default_levels = Config.DEFAULTS.levels
    for key in pairs(levels) do
        if default_levels[key] == nil then
            warn("unknown levels setting ignored: " .. tostring(key))
            levels[key] = nil
        end
    end
    if levels.enabled == nil then
        levels.enabled = default_levels.enabled
    elseif type(levels.enabled) ~= "boolean" then
        warn("levels.enabled must be true or false; using false")
        levels.enabled = false
    end
    if levels.maps == nil then
        levels.maps = default_levels.maps
    elseif type(levels.maps) == "table" then
        local kept = {}
        for _, entry in ipairs(levels.maps) do
            if type(entry) == "string" and entry:sub(1, 1) == "/" then
                kept[#kept + 1] = entry
            else
                warn("levels.maps entry ignored, a map path starts with /: " .. tostring(entry))
            end
        end
        levels.maps = kept
    elseif levels.maps ~= "auto" then
        warn('levels.maps must be "auto" or a list of map paths; using "auto"')
        levels.maps = "auto"
    end
    if levels.exclude == nil then
        levels.exclude = copy(default_levels.exclude)
    elseif type(levels.exclude) ~= "table" then
        warn("levels.exclude must be a list of text; using an empty list")
        levels.exclude = copy(default_levels.exclude)
    end
    if levels.pause_seconds == nil then
        levels.pause_seconds = default_levels.pause_seconds
    elseif type(levels.pause_seconds) ~= "number" or levels.pause_seconds < 0 or levels.pause_seconds > 60 then
        warn("levels.pause_seconds must be a number from 0 to 60; using " .. default_levels.pause_seconds)
        levels.pause_seconds = default_levels.pause_seconds
    end

    -- map_tour
    local tour = config.map_tour
    local default_tour = Config.DEFAULTS.map_tour
    for key in pairs(tour) do
        if default_tour[key] == nil then
            warn("unknown map_tour setting ignored: " .. tostring(key))
            tour[key] = nil
        end
    end
    if tour.enabled == nil then
        tour.enabled = default_tour.enabled
    elseif type(tour.enabled) ~= "boolean" then
        -- An unreadable switch must not open maps the user did not ask for.
        warn("map_tour.enabled must be true or false; using false")
        tour.enabled = false
    end
    if tour.maps == nil then
        tour.maps = default_tour.maps
    elseif type(tour.maps) == "table" then
        local kept = {}
        for _, entry in ipairs(tour.maps) do
            if type(entry) == "string" and entry:sub(1, 1) == "/" then
                kept[#kept + 1] = entry
            else
                warn("map_tour.maps entry ignored, a map path starts with /: " .. tostring(entry))
            end
        end
        tour.maps = kept
    elseif tour.maps ~= "auto" then
        warn('map_tour.maps must be "auto" or a list of map paths; using "auto"')
        tour.maps = "auto"
    end
    if tour.exclude == nil then
        tour.exclude = copy(default_tour.exclude)
    elseif type(tour.exclude) ~= "table" then
        warn("map_tour.exclude must be a list of text; using the default list")
        tour.exclude = copy(default_tour.exclude)
    end
    for _, key in ipairs({ "settle_seconds", "max_wait_seconds" }) do
        if tour[key] == nil then
            tour[key] = default_tour[key]
        elseif type(tour[key]) ~= "number" or tour[key] < 0 or tour[key] > 3600 then
            warn("map_tour." .. key .. " must be a number from 0 to 3600; using " .. default_tour[key])
            tour[key] = default_tour[key]
        end
    end

    for _, key in ipairs({ "freeze_input", "quit_when_done" }) do
        if auto[key] == nil then
            auto[key] = default_auto[key]
        elseif type(auto[key]) ~= "boolean" then
            warn("auto_run." .. key .. " must be true or false; using " .. tostring(default_auto[key]))
            auto[key] = default_auto[key]
        end
    end

    config.warnings = warnings
    return config
end

function Config.load(path, keys, modifier_keys)
    local chunk = loadfile(path)
    if not chunk then
        local config = Config.validate(nil, keys, modifier_keys)
        local probe = io.open(path, "rb")
        if probe then
            probe:close()
            config.warnings[#config.warnings + 1] = "config.lua has a syntax error; using defaults"
        end
        return config
    end
    local ok, loaded = pcall(chunk)
    if not ok then
        local config = Config.validate(nil, keys, modifier_keys)
        config.warnings[#config.warnings + 1] = "config.lua raised an error; using defaults: " .. tostring(loaded)
        return config
    end
    if loaded == nil then
        loaded = false
    end
    return Config.validate(loaded, keys, modifier_keys)
end

return Config
