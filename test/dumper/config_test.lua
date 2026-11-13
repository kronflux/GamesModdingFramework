local Config = require("gmfdumper.config")

local tests = {}

local KEYS = { NUM_ZERO = 0x60, F8 = 0x77 }
local MODS = { CONTROL = 0x11, SHIFT = 0x10 }

function tests.missing_file_gives_defaults_without_warnings(t)
    local config = Config.load(t.support.temp_dir("cfg") .. "\\config.lua", KEYS, MODS)
    t:eq(config.default_profile, "full")
    t:eq(config.output_root, "Dumps")
    t:eq(config.keybind.key, "NUM_ZERO")
    t:eq(config.also_write_shared_lua_types, true)
    t:eq(#config.warnings, 0)
end

function tests.shipped_config_is_valid(t)
    local config = Config.load(t.mod .. "/config.lua", KEYS, MODS)
    t:eq(#config.warnings, 0, table.concat(config.warnings, "; "))
    t:eq(config.default_profile, "full")
end

function tests.bad_values_fall_back_with_a_warning(t)
    local config = Config.validate({
        default_profile = "bogus",
        disabled_steps = { "uht", "nope" },
        keybind = { key = "F99", modifiers = { "CONTROL", "HYPER" } },
        include_blueprint_types = "yes",
        mystery = 1,
        output_root = "",
    }, KEYS, MODS)
    t:eq(config.default_profile, "full")
    t:eq(#config.disabled_steps, 1)
    t:eq(config.disabled_steps[1], "uht")
    t:eq(config.keybind.key, "NUM_ZERO")
    t:eq(#config.keybind.modifiers, 1)
    t:eq(config.include_blueprint_types, true)
    t:eq(config.output_root, "Dumps")
    t:eq(#config.warnings, 7, table.concat(config.warnings, "; "))
end

function tests.valid_values_are_kept(t)
    local config = Config.validate({ default_profile = "quick", keybind = { key = "F8", modifiers = {} },
        output_root = "D:\\Dumps", jmap_skip_property_values = true }, KEYS, MODS)
    t:eq(config.default_profile, "quick")
    t:eq(config.keybind.key, "F8")
    t:eq(#config.keybind.modifiers, 0)
    t:eq(config.output_root, "D:\\Dumps")
    t:eq(config.jmap_skip_property_values, true)
    t:eq(#config.warnings, 0)
end

function tests.broken_file_gives_defaults_and_a_warning(t)
    local dir = t.support.temp_dir("cfg")
    t.support.write(dir .. "\\config.lua", "return {")
    local config = Config.load(dir .. "\\config.lua", KEYS, MODS)
    t:eq(config.default_profile, "full")
    t:eq(#config.warnings, 1)
    t.support.write(dir .. "\\config.lua", "return 5")
    t:eq(#Config.load(dir .. "\\config.lua", KEYS, MODS).warnings, 1)
end

function tests.defaults_are_not_shared_between_loads(t)
    local a = Config.validate({}, KEYS, MODS)
    a.keybind.key = "F8"
    a.disabled_steps[1] = "uht"
    local b = Config.validate({}, KEYS, MODS)
    t:eq(b.keybind.key, "NUM_ZERO")
    t:eq(#b.disabled_steps, 0)
end

return tests
