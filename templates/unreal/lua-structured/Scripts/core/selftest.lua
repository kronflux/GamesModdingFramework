--[[
    core/selftest.lua — tiny in-game test harness.

    There is normally no Lua interpreter available on the machine a mod is
    developed on (UE4SS embeds its own), so the only place assertions about this
    mod's own logic can actually run is inside the game. Modules register named
    checks with SelfTest.Register(name, fn) at load time; the `selftest` console
    command (wired up in main.lua) runs every registered check and reports a
    PASS/FAIL summary — see VERIFY.md for how to read the result.
]]

local SelfTest = {}

local Checks = {}

---@param Name string
---@param Fn fun()  # call SelfTest.Ok / SelfTest.Eq inside; a raise counts as one failure
function SelfTest.Register(Name, Fn)
    table.insert(Checks, { Name = Name, Fn = Fn })
end

local CurrentName = "?"
local PassCount = 0
local FailCount = 0
local FailureLines = {}

local function RecordPass()
    PassCount = PassCount + 1
end

local function RecordFail(Message)
    FailCount = FailCount + 1
    table.insert(FailureLines, string.format("  [%s] %s", CurrentName, Message))
end

---@param Condition boolean
---@param Label string
function SelfTest.Ok(Condition, Label)
    if Condition then
        RecordPass()
    else
        RecordFail(string.format("%s: expected a truthy value", tostring(Label)))
    end
end

---@param Actual any
---@param Expected any
---@param Label string
function SelfTest.Eq(Actual, Expected, Label)
    if Actual == Expected then
        RecordPass()
    else
        RecordFail(string.format("%s: expected %s, got %s",
            tostring(Label), tostring(Expected), tostring(Actual)))
    end
end

---Runs every registered check and reports the result through OutputDevice (the
---UE console, when the caller has one) and print (the UE4SS log), so the result
---is visible however `selftest` was invoked.
---@param OutputDevice FOutputDevice|nil
---@return integer Passed
---@return integer Failed
function SelfTest.Run(OutputDevice)
    local function Emit(Line)
        if OutputDevice ~= nil then
            OutputDevice:Log(Line)
        end
        print(Line .. "\n")
    end

    PassCount, FailCount, FailureLines = 0, 0, {}

    for _, Check in ipairs(Checks) do
        CurrentName = Check.Name
        -- One check raising must not hide the results of every other check.
        local Ok, Err = pcall(Check.Fn)
        if not Ok then
            RecordFail("check raised: " .. tostring(Err))
        end
    end

    for _, Line in ipairs(FailureLines) do
        Emit(Line)
    end

    local ResultWord = (FailCount == 0) and "PASS" or "FAIL"
    Emit(string.format("[{{name}}] selftest: %s (%d passed, %d failed)",
        ResultWord, PassCount, FailCount))

    return PassCount, FailCount
end

-- Built-in check: proves the mod's shared UEHelpers module (shipped with UE4SS at Mods/shared/UEHelpers/UEHelpers.lua) is present and loadable.
-- This is the load-bearing check every other module implicitly depends on, so
-- it is registered here rather than left for a caller to remember to add.
SelfTest.Register("uehelpers", function()
    local Ok, UEHelpers = pcall(require, "UEHelpers")
    local Label = "UEHelpers module is present and loads"
    if not Ok then Label = Label .. " (require failed: " .. tostring(UEHelpers) .. ")" end
    SelfTest.Ok(Ok and type(UEHelpers) == "table", Label)
end)

return SelfTest
