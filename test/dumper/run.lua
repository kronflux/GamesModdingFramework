-- Offline test runner for the GmfDumper mod. Usage, from the repository root:
--   lua test/dumper/run.lua [name-filter]
-- Each test/dumper/*_test.lua returns a table of test name -> function(t).

local root = arg and arg[0] and arg[0]:match("^(.*)[/\\]test[/\\]dumper[/\\]run%.lua$") or "."
local mod = root .. "/templates/unreal/dumper/Mods/GmfDumper"
package.path = table.concat({
    mod .. "/Scripts/?.lua",
    mod .. "/Scripts/vendor/?.lua",
    root .. "/test/dumper/?.lua",
    package.path,
}, ";")

local filter = arg and arg[1]

local T = {}
T.__index = T

function T:eq(actual, expected, label)
    if actual ~= expected then
        error(string.format("%s: expected %s, got %s", label or "eq", tostring(expected), tostring(actual)), 2)
    end
end

function T:ok(value, label)
    if not value then
        error((label or "ok") .. ": expected a true value, got " .. tostring(value), 2)
    end
end

function T:no(value, label)
    if value then
        error((label or "no") .. ": expected a false value, got " .. tostring(value), 2)
    end
end

local support = require("support.fakes")
T.root = root
T.mod = mod
T.support = support

local files = {}
local pipe = assert(io.popen('dir /b "' .. (root .. "\\test\\dumper"):gsub("/", "\\") .. '" 2>nul'))
for line in pipe:lines() do
    local name = line:match("^(.-_test)%.lua")
    if name and (not filter or name:find(filter, 1, true)) then
        files[#files + 1] = name
    end
end
pipe:close()
table.sort(files)

local passed, failed = 0, 0
for _, name in ipairs(files) do
    local tests = require(name)
    local names = {}
    for test_name in pairs(tests) do
        names[#names + 1] = test_name
    end
    table.sort(names)
    for _, test_name in ipairs(names) do
        local t = setmetatable({}, T)
        local ok, err = xpcall(tests[test_name], debug.traceback, t)
        if ok then
            passed = passed + 1
        else
            failed = failed + 1
            print(string.format("FAIL %s: %s\n%s", name, test_name, err))
        end
    end
end

support.cleanup()
print(string.format("%d passed, %d failed, %d files", passed, failed, #files))
os.exit(failed == 0 and 0 or 1)
