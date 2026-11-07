-- GmfDumper
--
-- THIN, OPTIONAL wrapper over UE4SS's native dump globals: DumpAllObjects, DumpAllActors,
-- DumpStaticMeshes, DumpUSMAP and DumpJMAP. It never reimplements one of them. It only
-- batches them behind one console command and one key bind, runs each under pcall so one
-- failure cannot stop the rest, and writes GmfDumper_report.txt beside the dumps. The report
-- starts with the engine and UE4SS version lines so a tool can read it without parsing the rest.
-- The native key binds and the GUI Dumpers tab stay the primary way to run a single dump.
-- Using or skipping this mod never disables a built-in dumper, and this file must never grow
-- a copy of a native function: always call the global.
--
-- Console command: gmfdump [all|objects|actors|meshes|usmap|jmap]   (default: all)
-- Key bind: F8 runs "all". Change it with DumpKey under [GmfDumper] in UE4SS-settings.ini.
--
-- Uses only UE4SS globals; the vendored shared/UEHelpers module is installed beside it for
-- other mods and is not required here.

local LOG_PREFIX = "[GmfDumper] "
local REPORT_FILE_NAME = "GmfDumper_report.txt"
local DEFAULT_KEY = "F8"

-- Each entry names the native global as a string. The global is looked up when the dump runs,
-- not at load, so a UE4SS build that lacks one reports "not available" instead of failing here.
local Dumps = {
    { Id = "objects", Label = "All Objects",     Native = "DumpAllObjects" },
    { Id = "actors",  Label = "All Actors",      Native = "DumpAllActors" },
    { Id = "meshes",  Label = "Static Meshes",   Native = "DumpStaticMeshes" },
    { Id = "usmap",   Label = "USMAP Mapping",   Native = "DumpUSMAP" },
    { Id = "jmap",    Label = "JMAP Reflection", Native = "DumpJMAP" },
}

-- Outcome of the latest attempt of each dump in this session, so a single dump does not erase
-- the earlier results from the report.
local Results = {}

local function Log(Message)
    print(LOG_PREFIX .. Message .. "\n")
end

---The UE4SS folder (the one holding Mods/ and UE4SS-settings.ini), derived from this file's own
---path: <ue4ss>/Mods/GmfDumper/Scripts/main.lua. Returns nil when the path cannot be read.
local function GetUe4ssDir()
    local Ok, Info = pcall(debug.getinfo, 1, "S")
    if Ok and Info and type(Info.source) == "string" and Info.source:sub(1, 1) == "@" then
        local Normalized = Info.source:sub(2):gsub("\\", "/")
        return Normalized:match("^(.*)/Mods/[^/]+/Scripts/[^/]+$")
    end
    return nil
end

local Ue4ssDir = GetUe4ssDir()

---Where the report is written: beside the dumps in the UE4SS folder. A bare file name would
---resolve against the game's working directory (Binaries/Win64) instead.
local function ReportPath()
    if Ue4ssDir then return Ue4ssDir .. "/" .. REPORT_FILE_NAME end
    return REPORT_FILE_NAME
end

---Reads UE4SS-settings.ini from the places UE4SS keeps it. Returns the text or nil.
local function ReadSettingsText()
    local Candidates = { "UE4SS-settings.ini", "ue4ss/UE4SS-settings.ini", "../UE4SS-settings.ini" }
    if Ue4ssDir then table.insert(Candidates, 1, Ue4ssDir .. "/UE4SS-settings.ini") end
    for _, Path in ipairs(Candidates) do
        local FileOk, File = pcall(io.open, Path, "r")
        if FileOk and File then
            local Text = File:read("*a")
            File:close()
            return Text
        end
    end
    return nil
end

---Returns the value of Key inside [Section], or nil. Case-insensitive, ignores ; and # comments.
local function ReadIniValue(Text, Section, Key)
    local Current = nil
    for Line in (Text .. "\n"):gmatch("([^\r\n]*)\r?\n") do
        local Trimmed = Line:match("^%s*(.-)%s*$")
        local Name = Trimmed:match("^%[(.-)%]$")
        if Name then
            Current = Name:lower()
        elseif Current == Section:lower() and Trimmed:sub(1, 1) ~= ";" and Trimmed:sub(1, 1) ~= "#" then
            local K, V = Trimmed:match("^([^=]-)%s*=%s*(.-)%s*$")
            if K and K:lower() == Key:lower() then return V end
        end
    end
    return nil
end

local Settings = ReadSettingsText()

---Console commands only reach this mod when UE4SS hooks ProcessConsoleExec. Warn when the
---settings say it is off, or when the settings cannot be read at all. The key bind still works.
local function CheckConsoleHook()
    if Settings == nil then
        Log("WARNING: could not read UE4SS-settings.ini, so HookProcessConsoleExec is unknown. If gmfdump does nothing, use the F8 key bind.")
        return
    end
    local Value = ReadIniValue(Settings, "Hooks", "HookProcessConsoleExec")
    if Value == "0" or (Value ~= nil and Value:lower() == "false") then
        Log("WARNING: HookProcessConsoleExec = 0 in UE4SS-settings.ini, so the gmfdump console command cannot fire. Set it to 1 under [Hooks] or use the F8 key bind.")
    end
end

local function GetEngineVersionString()
    local Ok, Major, Minor = pcall(function() return UnrealVersion.GetMajor(), UnrealVersion.GetMinor() end)
    if Ok and Major ~= nil and Minor ~= nil then
        return string.format("%s.%s", tostring(Major), tostring(Minor))
    end
    return "unknown"
end

local function GetUE4SSVersionString()
    if UE4SS == nil then
        return "unknown (UE4SS global class not present, pre-1.1 build)"
    end
    local Ok, Major, Minor, Hotfix = pcall(UE4SS.GetVersion)
    if Ok and Major ~= nil then
        return string.format("%s.%s.%s", tostring(Major), tostring(Minor), tostring(Hotfix))
    end
    return "unknown"
end

---Runs one dump under pcall. Calls the native global and nothing else.
local function RunDump(Entry)
    local Native = _G[Entry.Native]
    local Success, Detail
    if type(Native) ~= "function" then
        Success, Detail = false, "native " .. Entry.Native .. " is not available in this UE4SS build"
    else
        local Ok, Err = pcall(Native)
        Success, Detail = Ok, Ok and "ok" or tostring(Err)
    end
    Results[Entry.Id] = { Entry = Entry, Success = Success, Detail = Detail, At = os.date("%Y-%m-%d %H:%M:%S") }
    Log(string.format("%s: %s", Entry.Label, Success and "ok" or ("FAILED (" .. Detail .. ")")))
    return Success, Detail
end

---Writes the report. The two version lines come first. Always closes the file.
local function WriteReport()
    local Ok, File = pcall(io.open, ReportPath(), "w")
    if not Ok or File == nil then
        Log("could not open " .. ReportPath() .. " for writing")
        return false
    end
    local WriteOk, WriteErr = pcall(function()
        File:write(string.format("Unreal Engine version: %s\n", GetEngineVersionString()))
        File:write(string.format("UE4SS version: %s\n", GetUE4SSVersionString()))
        File:write("GmfDumper report written: " .. os.date("%Y-%m-%d %H:%M:%S") .. "\n\nDump attempts:\n")
        local Any = false
        for _, Entry in ipairs(Dumps) do
            local R = Results[Entry.Id]
            if R then
                Any = true
                File:write(string.format("  - %s (%s, %s): %s at %s\n", Entry.Label, Entry.Id, Entry.Native,
                    R.Success and "OK" or ("FAILED - " .. R.Detail), R.At))
            end
        end
        if not Any then File:write("  (no dumps have run yet this session)\n") end
    end)
    File:close()
    if not WriteOk then Log("failed while writing report: " .. tostring(WriteErr)) end
    return WriteOk
end

---Runs the dump named Which ("all" or an Id), writes the report and returns a one-line summary.
local function Run(Which)
    Which = (Which or "all"):lower()
    local Selected = {}
    for _, Entry in ipairs(Dumps) do
        if Which == "all" or Which == Entry.Id then table.insert(Selected, Entry) end
    end
    if #Selected == 0 then
        return "unknown dump '" .. Which .. "'. Usage: gmfdump [all|objects|actors|meshes|usmap|jmap]"
    end
    local Failed = 0
    for _, Entry in ipairs(Selected) do
        if not RunDump(Entry) then Failed = Failed + 1 end
    end
    WriteReport()
    return string.format("%d dump(s) run, %d failed, report: %s", #Selected, Failed, ReportPath())
end

RegisterConsoleCommandHandler("gmfdump", function(FullCommand, Parameters, OutputDevice)
    local Summary = Run(Parameters and Parameters[1] or "all")
    Log(Summary)
    pcall(function() OutputDevice:Log("GmfDumper: " .. Summary) end)
    return true
end)

---The key comes from DumpKey under [GmfDumper]; an unknown name falls back to F8.
local KeyName = DEFAULT_KEY
if Settings ~= nil then
    local Configured = ReadIniValue(Settings, "GmfDumper", "DumpKey")
    if Configured and Configured ~= "" then KeyName = Configured end
end
local KeyValue = Key[KeyName] or Key[KeyName:upper()]
if KeyValue == nil then
    Log("unknown DumpKey '" .. KeyName .. "', using " .. DEFAULT_KEY)
    KeyName, KeyValue = DEFAULT_KEY, Key[DEFAULT_KEY]
end
-- Key callbacks run on the UE4SS event-loop thread; the dump globals walk the object array and
-- belong on the game thread.
RegisterKeyBind(KeyValue, function()
    ExecuteInGameThread(function()
        local Ok, Summary = pcall(Run, "all")
        Log("key bind " .. KeyName .. ": " .. (Ok and Summary or ("FAILED (" .. tostring(Summary) .. ")")))
    end)
end)

CheckConsoleHook()
Log(string.format("loaded. Console: gmfdump [all|objects|actors|meshes|usmap|jmap]. Key: %s runs all. Report: %s",
    KeyName, REPORT_FILE_NAME))
