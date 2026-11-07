--[[
    core/config.lua — load/save {{name}}'s config as a plain Lua table.

    Format: the config file is valid Lua source that returns a table, e.g.

        return {
            ["ExampleFeatureEnabled"] = true,
            ["ExampleThreshold"] = 10,
        }

    A Lua table is used rather than JSON because UE4SS does not ship a JSON
    module for Lua mods (see core/util.lua's header for why keybinds.json still
    gets its own small reader), and Lua's own `load()` gives a safe, sandboxed
    way to read a hand-editable config file back without hand-writing a general
    JSON encoder/decoder for something that only ever needs to hold simple
    values (numbers, strings, booleans).
]]

local Util = require("core.util")

local Config = {}

-- In the mod folder, next to Scripts/ (Util.ModPath: never a relative io.open path).
local FILE_NAME = Util.ModPath("config.lua")

---Values used when the config file is missing or fails to load. Add a field
---here first when introducing a new config key, so Config.Load always returns
---every key a caller expects — including on a brand-new install that has never
---written a config file.
Config.Defaults = {
    ExampleFeatureEnabled = false,
    ExampleThreshold = 10,
    -- Gate for features/*.lua modules' OWN keybinds (their ctx.keybinds_enabled,
    -- wired from this value in main.lua's features loader) — separate from this
    -- file's own keybinds.json/.example mechanism below. Defaults to false:
    -- never assume keybinds are wanted (a required, never-assumed question).
    KeybindsEnabled = false,
}

---@param Defaults table
---@param Loaded table|nil
---@return table
local function MergeWithDefaults(Defaults, Loaded)
    local Merged = {}
    for Key, Value in pairs(Defaults) do
        Merged[Key] = Value
    end
    if type(Loaded) == "table" then
        for Key, Value in pairs(Loaded) do
            local Default = Defaults[Key]
            -- A key with a default only accepts a value of the same type, so a
            -- hand-edit like ExampleThreshold = "ten" cannot reach code that
            -- does arithmetic on it. Keys without a default pass through.
            if Default == nil or type(Value) == type(Default) then
                Merged[Key] = Value
            else
                Util.Log(string.format("Config key '%s' has type %s, expected %s; using the default.",
                    tostring(Key), type(Value), type(Default)))
            end
        end
    end
    return Merged
end

---Reads FILE_NAME (an absolute path in the mod folder, from Util.ModPath) and
---merges it over Config.Defaults. Never raises: a missing or invalid file
---simply yields the defaults.
---@return table
function Config.Load()
    local File = io.open(FILE_NAME, "r")
    if File == nil then
        Util.Log(string.format("No config file '%s' yet; using defaults.", FILE_NAME))
        return MergeWithDefaults(Config.Defaults, nil)
    end

    local Text = File:read("*a")
    File:close()

    -- The config IS Lua source, loaded with an EMPTY environment table (the `{}`
    -- 4th argument) so a hand-edited file can only build a table literal — it
    -- cannot reach any global, call another function, or run arbitrary logic.
    -- "t" also refuses precompiled bytecode, which has no business in a config.
    local Chunk, CompileError = load(Text or "", FILE_NAME, "t", {})
    if Chunk == nil then
        Util.Log(string.format("Config file '%s' is not valid Lua (%s); using defaults.",
            FILE_NAME, tostring(CompileError)))
        return MergeWithDefaults(Config.Defaults, nil)
    end

    -- A corrupt-but-compiling chunk (e.g. one that errors while building the
    -- table) must not stop the mod loading either.
    local Ok, Loaded = pcall(Chunk)
    if not Ok or type(Loaded) ~= "table" then
        Util.Log(string.format("Config file '%s' did not return a table; using defaults.",
            FILE_NAME))
        return MergeWithDefaults(Config.Defaults, nil)
    end

    return MergeWithDefaults(Config.Defaults, Loaded)
end

---Lua source text for a number that loads back to the same value: integers
---print exactly, floats use 17 significant digits, infinities become an
---out-of-range literal, and NaN has no literal so it returns nil (skipped).
---@param Value number
---@return string|nil
local function NumberText(Value)
    if Value ~= Value then return nil end
    if Value == math.huge then return "1e999" end
    if Value == -math.huge then return "-1e999" end
    if math.type ~= nil and math.type(Value) == "integer" then
        return string.format("%d", Value)
    end
    return string.format("%.17g", Value)
end

---Serializes a flat table of string/number/boolean values as Lua source that
---Config.Load can read back. Keys are sorted so the same values always produce
---byte-identical output (pairs() order is unspecified and would otherwise churn
---the file on every save for no reason).
---@param Values table
---@return string
function Config.Serialize(Values)
    local Keys = {}
    for Key in pairs(Values) do
        table.insert(Keys, Key)
    end
    -- Compare as strings: a table mixing string and number keys would make the
    -- default comparator raise "attempt to compare number with string".
    table.sort(Keys, function(A, B)
        local TextA, TextB = tostring(A), tostring(B)
        if TextA ~= TextB then return TextA < TextB end
        return type(A) < type(B)
    end)

    local Lines = {
        "-- {{name}} config, written by Config.Save(). Safe to hand-edit.",
        "return {",
    }

    for _, Key in ipairs(Keys) do
        local Value = Values[Key]
        local ValueText = nil
        if type(Value) == "string" then
            ValueText = string.format("%q", Value)
        elseif type(Value) == "number" then
            ValueText = NumberText(Value)
        elseif type(Value) == "boolean" then
            ValueText = tostring(Value)
        end
        -- Anything else (nil, function, table, ...) is not a value this format
        -- supports; it is skipped rather than writing something Config.Load
        -- could not read back.
        if ValueText ~= nil then
            table.insert(Lines, string.format("    [%q] = %s,", Key, ValueText))
        end
    end

    table.insert(Lines, "}")
    table.insert(Lines, "")
    return table.concat(Lines, "\n")
end

---Writes Values to FILE_NAME. The text is serialized first and written to a
---sibling temporary file, which then replaces FILE_NAME, so a failed
---serialization or write never truncates the existing config.
---@param Values table
---@return boolean Ok
---@return string|nil Err
function Config.Save(Values)
    local SerializeOk, Text = pcall(Config.Serialize, Values)
    if not SerializeOk then
        return false, string.format("could not serialize the config: %s", tostring(Text))
    end

    local TempName = FILE_NAME .. ".tmp"
    local OpenOk, FileOrError = pcall(io.open, TempName, "w")
    if not OpenOk or FileOrError == nil then
        return false, string.format("could not open '%s' for writing", TempName)
    end

    local File = FileOrError
    local WriteOk, WriteResult, WriteErr = pcall(File.write, File, Text)
    local CloseOk = File:close()

    if not WriteOk or not WriteResult then
        os.remove(TempName)
        return false, tostring(WriteOk and WriteErr or WriteResult)
    end
    if not CloseOk then
        os.remove(TempName)
        return false, string.format("could not flush '%s'", TempName)
    end

    local RenameOk, RenameErr = os.rename(TempName, FILE_NAME)
    if not RenameOk then
        -- On Windows rename does not replace an existing file: remove the old
        -- config and retry. The temporary file holds the new content throughout.
        os.remove(FILE_NAME)
        RenameOk, RenameErr = os.rename(TempName, FILE_NAME)
    end
    if not RenameOk then
        return false, string.format("could not move '%s' over '%s': %s",
            TempName, FILE_NAME, tostring(RenameErr))
    end

    Util.Log(string.format("Config saved to '%s'.", FILE_NAME))
    return true
end

return Config
