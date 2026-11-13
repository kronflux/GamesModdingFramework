-- Helpers shared by the offline tests: temp folders on the real disk and file helpers.

local M = {}

local created = {}
local counter = 0

local function win(path)
    return (path:gsub("/", "\\"))
end

function M.temp_dir(label)
    counter = counter + 1
    local base = os.getenv("TEMP") or "."
    local dir = string.format("%s\\gmfdumper-test-%d-%d-%s", base, os.time(), counter, label or "t")
    os.execute('mkdir "' .. dir .. '" >nul 2>nul')
    created[#created + 1] = dir
    return dir
end

function M.write(path, text)
    local f = assert(io.open(path, "wb"))
    f:write(text or "x")
    f:close()
end

function M.read(path)
    local f = io.open(path, "rb")
    if not f then
        return nil
    end
    local text = f:read("a")
    f:close()
    return text
end

function M.mkdir(path)
    os.execute('mkdir "' .. win(path) .. '" >nul 2>nul')
end

function M.cleanup()
    for _, dir in ipairs(created) do
        -- Only folders this module created under TEMP, matched by their fixed prefix.
        if dir:find("gmfdumper-test-", 1, true) then
            os.execute('rmdir /s /q "' .. dir .. '" >nul 2>nul')
        end
    end
    created = {}
end

return M
