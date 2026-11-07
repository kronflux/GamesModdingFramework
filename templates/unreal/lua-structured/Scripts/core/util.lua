--[[
    core/util.lua — small helpers shared across {{name}}'s modules.

    Every game-object access below goes through a pcall-guarded wrapper so a
    stale/invalid UObject reference (level travel, an actor being destroyed,
    etc.) degrades to a logged no-op instead of raising and killing whatever
    tick/command touched it. See RE-UE4SS/docs/lua-api/classes/uobject.md for
    IsValid(), which every wrapper here is built on.
]]

local Util = {}

local LOG_PREFIX = "[{{name}}] "

---Prints a prefixed, newline-terminated log line.
---RE-UE4SS/docs/lua-api/global-functions/print.md
---@param Message any
function Util.Log(Message)
    print(LOG_PREFIX .. tostring(Message) .. "\n")
end

---Absolute path of a file in this mod's own folder (the one holding Scripts/).
---
---Never pass a bare file name to io.open: UE4SS resolves a relative path against
---its working directory, <Game>/Binaries/Win64, not the mod folder, so the file
---is silently never found (mod-relative path resolution, gotcha G1).
---The folder may be named Scripts or scripts.
---@param Name string e.g. "config.lua"
---@return string Path absolute when the mod folder could be found, else Name
function Util.ModPath(Name)
    local Info = debug.getinfo(1, "S")
    local Source = (Info and Info.source or ""):gsub("^@", "")
    local Dir = Source:match("^(.*[/\\])[Ss]cripts[/\\]")
    if Dir == nil then return Name end
    return Dir .. Name
end

---True only if Obj is a non-nil UObject that is still valid.
---RE-UE4SS/docs/lua-api/classes/uobject.md -> IsValid()
---@param Obj any
---@return boolean
function Util.IsValid(Obj)
    if Obj == nil then return false end
    local Ok, Result = pcall(function() return Obj:IsValid() end)
    return Ok and Result == true
end

---Reads Obj[Field], returning nil instead of raising if Obj is invalid or the
---read itself raises.
---@param Obj any
---@param Field string
---@return any
function Util.Get(Obj, Field)
    if not Util.IsValid(Obj) then return nil end
    local Ok, Result = pcall(function() return Obj[Field] end)
    if Ok then return Result end
    return nil
end

---Runs Fn under pcall, logging (and swallowing) any error instead of letting it
---propagate into UE4SS or the game.
---@param Fn function
---@param Context string|nil  # short label used in the log line if Fn raises
---@return boolean Ok
function Util.SafeCall(Fn, Context)
    local Ok, Err = pcall(Fn)
    if not Ok then
        Util.Log(string.format("%s FAILED: %s", Context or "SafeCall", tostring(Err)))
    end
    return Ok
end

local TRUE_WORDS = { ["1"] = true, ["true"] = true, ["on"] = true, ["yes"] = true }

local FALSE_WORDS = { ["0"] = true, ["false"] = true, ["off"] = true, ["no"] = true }

---Interprets boolean-style console command arguments: "on", "1", "true" and
---"yes" are true; "off", "0", "false" and "no" are false. Anything else
---(including a typo) falls back to Default.
---@param Value string|nil
---@param Default boolean
---@return boolean
function Util.ParseBool(Value, Default)
    if Value == nil then return Default end
    local Word = tostring(Value):lower()
    if TRUE_WORDS[Word] then return true end
    if FALSE_WORDS[Word] then return false end
    return Default
end

-- Always-indexable console command parameters: UE4SS hands a bare command (no
-- arguments) a nil Parameters table rather than an empty one (see
-- RE-UE4SS/docs/lua-api/global-functions/registerconsolecommandhandler.md), so
-- indexing the raw callback argument directly raises on a bare command. Route
-- every handler's Parameters through here first.
local EMPTY_PARAMS = {}

---@param P table|nil
---@return table
function Util.Params(P)
    if type(P) ~= "table" then return EMPTY_PARAMS end
    return P
end

--------------------------------------------------------------------------------
--  Minimal JSON object reader — keybinds.json only
--------------------------------------------------------------------------------

-- UE4SS does not ship a JSON module for Lua mods: there is no global
-- `require("json")`, and it is absent from RE-UE4SS/docs and from the engine's
-- own Lua bindings. Mods that want to read a hand-authored JSON file bring
-- their own small reader. This one intentionally supports only the shape
-- keybinds.json actually needs:
--
--   { "Keybinds": { "<KeyName>": "<Label>", ... }, ...other string members ignored... }
--
-- No nesting beyond "Keybinds", no arrays, no numbers/booleans/null, no escape
-- sequences. That is a deliberate scope limit, not an oversight: a hand-edited
-- key -> label map never needs any of those, and a reader that does not support
-- them cannot silently mis-parse them either. Any input outside this shape
-- yields an empty table rather than raising, so a malformed file degrades to
-- "no keybinds loaded" instead of crashing the mod.

---Advances past a run of whitespace, returning the first non-whitespace index.
local function SkipWS(Text, Pos)
    local _, EndPos = Text:find("^%s*", Pos)
    return EndPos + 1
end

---Reads a "quoted string" starting at Pos (Text:sub(Pos,Pos) must be '"').
---No escape sequences are supported; a backslash inside the string fails the
---match, which is a clean rejection rather than a mis-read closing quote.
---@return string|nil Value
---@return integer AfterPos  # unchanged (== Pos) when Value is nil
local function ReadQuotedString(Text, Pos)
    if Text:sub(Pos, Pos) ~= '"' then return nil, Pos end
    local Value, AfterPos = Text:match('^"([^"\\]*)"()', Pos)
    if Value == nil then return nil, Pos end
    return Value, AfterPos
end

---Reads the inner `{ "Key": "Label", ... }` object that is the value of
---"Keybinds". Pos must point at its opening '{'.
---@return table Binds  # KeyName -> Label; {} unless the object is complete and closed
local function ReadKeybindsObject(Text, Pos)
    local Binds = {}
    Pos = SkipWS(Text, Pos + 1) -- past '{'
    if Text:sub(Pos, Pos) == "}" then return Binds end

    while true do
        local Key
        Key, Pos = ReadQuotedString(Text, Pos)
        if Key == nil then return {} end

        Pos = SkipWS(Text, Pos)
        if Text:sub(Pos, Pos) ~= ":" then return {} end
        Pos = SkipWS(Text, Pos + 1)

        local Value
        Value, Pos = ReadQuotedString(Text, Pos)
        if Value == nil then return {} end

        Binds[Key] = Value

        Pos = SkipWS(Text, Pos)
        local Char = Text:sub(Pos, Pos)
        if Char == "}" then return Binds end
        if Char ~= "," then return {} end
        Pos = SkipWS(Text, Pos + 1)
        if Text:sub(Pos, Pos) == "}" then return Binds end
    end
end

---Parses a keybinds.json-shaped document and returns its "Keybinds" table.
---Never raises: any structural problem it doesn't understand simply yields an
---empty table.
---@param Text string
---@return table Binds  # KeyName -> Label ({} if missing/invalid)
function Util.ParseKeybindsJSON(Text)
    local Ok, Result = pcall(function()
        if type(Text) ~= "string" or Text:match("^%s*$") then return {} end

        local Pos = SkipWS(Text, 1)
        if Text:sub(Pos, Pos) ~= "{" then return {} end
        Pos = SkipWS(Text, Pos + 1)

        while Pos <= #Text and Text:sub(Pos, Pos) ~= "}" do
            local Key
            Key, Pos = ReadQuotedString(Text, Pos)
            if Key == nil then return {} end

            Pos = SkipWS(Text, Pos)
            if Text:sub(Pos, Pos) ~= ":" then return {} end
            Pos = SkipWS(Text, Pos + 1)

            if Key == "Keybinds" and Text:sub(Pos, Pos) == "{" then
                return ReadKeybindsObject(Text, Pos)
            end

            -- Any other top-level member (e.g. "Instructions") must be a plain
            -- string; it is read and discarded. Anything else on a non-Keybinds
            -- key is outside this reader's scope, so the whole parse yields no
            -- binds rather than guessing what was meant.
            if Text:sub(Pos, Pos) ~= '"' then return {} end
            local Discarded, After = ReadQuotedString(Text, Pos)
            if Discarded == nil then return {} end
            Pos = SkipWS(Text, After)

            -- Members are separated by a comma; anything but a comma or the
            -- closing brace here is malformed.
            local Separator = Text:sub(Pos, Pos)
            if Separator == "," then
                Pos = SkipWS(Text, Pos + 1)
            elseif Separator ~= "}" then
                return {}
            end
        end

        return {}
    end)

    if Ok and type(Result) == "table" then return Result end
    return {}
end

return Util
