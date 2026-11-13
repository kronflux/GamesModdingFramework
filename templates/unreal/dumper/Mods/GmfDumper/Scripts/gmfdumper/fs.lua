-- File operations. Uses the native functions when the C++ part is loaded, and plain Lua
-- otherwise. Stock UE4SS Lua has no way to create or list folders, so the fallback shells
-- out to cmd for those two operations only.

local Fs = {}

local function win(path)
    return (path:gsub("/", "\\"))
end

-- A path is only passed to cmd when it cannot break out of the quotes around it.
local function shell_safe(path)
    return not path:find('["%%!\r\n]')
end

local function lua_exists(path)
    local ok, _, code = os.rename(path, path)
    -- Code 13 is "permission denied": the path exists but is in use.
    return ok ~= nil or code == 13
end

local function lua_is_dir(path)
    if not lua_exists(path) then
        return false
    end
    -- On Windows a folder cannot be opened as a file, so a path that exists and does not
    -- open is a folder. A file locked by another process also lands here; the native
    -- IsDir has no such blind spot.
    local f = io.open(path, "rb")
    if f then
        f:close()
        return false
    end
    return true
end

local function lua_list(path)
    local names = {}
    if not shell_safe(path) or not lua_exists(path) then
        return names
    end
    local pipe = io.popen('dir /b /a "' .. win(path) .. '" 2>nul')
    if not pipe then
        return names
    end
    for line in pipe:lines() do
        if line ~= "" then
            names[#names + 1] = line
        end
    end
    pipe:close()
    return names
end

local function lua_size(path)
    local f = io.open(path, "rb")
    if not f then
        return nil
    end
    local size = f:seek("end")
    f:close()
    return size
end

local function lua_mkdirs(path)
    if lua_exists(path) then
        return true
    end
    if not shell_safe(path) then
        return nil, "unsafe path for mkdir: " .. path
    end
    os.execute('mkdir "' .. win(path) .. '" >nul 2>nul')
    if lua_exists(path) then
        return true
    end
    return nil, "could not create folder: " .. path
end

local function lua_copy(from, to)
    local src, err = io.open(from, "rb")
    if not src then
        return nil, err
    end
    local dst, err2 = io.open(to, "wb")
    if not dst then
        src:close()
        return nil, err2
    end
    while true do
        local chunk = src:read(1 << 20)
        if not chunk then
            break
        end
        dst:write(chunk)
    end
    src:close()
    dst:close()
    return true
end

local function lua_move(from, to)
    local ok, err = os.rename(from, to)
    if ok then
        return true
    end
    -- os.rename cannot cross volumes. Files can be copied instead; folders cannot here.
    if lua_is_dir(from) then
        return nil, "could not move folder: " .. tostring(err)
    end
    local copied, copy_err = lua_copy(from, to)
    if not copied then
        return nil, "could not move file: " .. tostring(copy_err)
    end
    os.remove(from)
    return true
end

-- Wraps a native call so that a native error value or a raised error both come back as
-- nil, message.
local function guarded(fn, ...)
    local results = table.pack(pcall(fn, ...))
    if not results[1] then
        return nil, tostring(results[2])
    end
    if results[2] == nil or results[2] == false then
        return nil, tostring(results[3] or "native call failed")
    end
    return table.unpack(results, 2, results.n)
end

function Fs.new(native)
    native = native or {}
    local fs = {}

    function fs.exists(path)
        return lua_exists(path)
    end

    function fs.is_dir(path)
        if native.IsDir then
            local result = guarded(native.IsDir, path)
            return result == true
        end
        return lua_is_dir(path)
    end

    function fs.mkdirs(path)
        if native.MakeDirs then
            return guarded(native.MakeDirs, path)
        end
        return lua_mkdirs(path)
    end

    function fs.move(from, to)
        if native.Move then
            return guarded(native.Move, from, to)
        end
        return lua_move(from, to)
    end

    function fs.list(path)
        if native.ListDir then
            local text = guarded(native.ListDir, path)
            local names = {}
            if type(text) == "string" then
                for line in text:gmatch("[^\n]+") do
                    names[#names + 1] = line
                end
            end
            return names
        end
        return lua_list(path)
    end

    function fs.size(path)
        if native.FileSize then
            local size = guarded(native.FileSize, path)
            return math.type(size) == "integer" and size or nil
        end
        return lua_size(path)
    end

    function fs.read(path)
        local f, err = io.open(path, "rb")
        if not f then
            return nil, err
        end
        local text = f:read("a")
        f:close()
        return text
    end

    function fs.copy(from, to)
        return lua_copy(from, to)
    end

    -- Writes to a temp file beside the target, then replaces the target, so a reader never
    -- sees a half-written file.
    function fs.write_atomic(path, text)
        local temp = path .. ".tmp"
        local f, err = io.open(temp, "wb")
        if not f then
            return nil, err
        end
        f:write(text)
        f:close()
        if native.Move then
            return guarded(native.Move, temp, path)
        end
        os.remove(path)
        local ok, rename_err = os.rename(temp, path)
        if not ok then
            return nil, rename_err
        end
        return true
    end

    -- Returns total bytes and file count under a folder, or the size and 1 for a file.
    function fs.tree_stats(path)
        if native.TreeStats then
            local text = guarded(native.TreeStats, path)
            if type(text) == "string" then
                local bytes, count = text:match("^(%d+) (%d+)$")
                if bytes then
                    return math.tointeger(bytes), math.tointeger(count)
                end
            end
            return 0, 0
        end
        if not fs.is_dir(path) then
            local size = lua_size(path)
            if size then
                return size, 1
            end
            return 0, 0
        end
        local bytes, count = 0, 0
        for _, name in ipairs(lua_list(path)) do
            local b, c = fs.tree_stats(path .. "\\" .. name)
            bytes = bytes + b
            count = count + c
        end
        return bytes, count
    end

    function fs.copy_tree(from, to)
        if not fs.is_dir(from) then
            return fs.copy(from, to)
        end
        local ok, err = fs.mkdirs(to)
        if not ok then
            return nil, err
        end
        for _, name in ipairs(fs.list(from)) do
            local copied, copy_err = fs.copy_tree(from .. "\\" .. name, to .. "\\" .. name)
            if not copied then
                return nil, copy_err
            end
        end
        return true
    end

    return fs
end

return Fs
