local Fs = require("gmfdumper.fs")

local tests = {}

function tests.mkdirs_creates_nested_folders(t)
    local fs = Fs.new(nil)
    local dir = t.support.temp_dir("mk") .. "\\a\\b\\c"
    t:no(fs.exists(dir), "missing before")
    t:ok(fs.mkdirs(dir), "mkdirs")
    t:ok(fs.exists(dir), "exists after")
    t:ok(fs.is_dir(dir), "is_dir")
    t:ok(fs.mkdirs(dir), "mkdirs again is fine")
end

function tests.mkdirs_refuses_unsafe_path(t)
    local fs = Fs.new(nil)
    local ok, err = fs.mkdirs('C:\\x" & echo boom & "')
    t:no(ok, "refused")
    t:ok(err and err:find("unsafe", 1, true), "error names the reason")
    local ok2 = fs.mkdirs("C:\\x%PATH%")
    t:no(ok2, "percent refused")
end

function tests.move_file_and_folder(t)
    local fs = Fs.new(nil)
    local dir = t.support.temp_dir("mv")
    t.support.write(dir .. "\\one.txt", "hello")
    t:ok(fs.mkdirs(dir .. "\\out"))
    t:ok(fs.move(dir .. "\\one.txt", dir .. "\\out\\one.txt"), "move file")
    t:no(fs.exists(dir .. "\\one.txt"), "source gone")
    t:eq(fs.read(dir .. "\\out\\one.txt"), "hello", "content kept")

    t:ok(fs.mkdirs(dir .. "\\tree\\sub"))
    t.support.write(dir .. "\\tree\\sub\\f.txt", "abc")
    t:ok(fs.move(dir .. "\\tree", dir .. "\\out\\tree"), "move folder")
    t:eq(fs.read(dir .. "\\out\\tree\\sub\\f.txt"), "abc", "folder content kept")
    t:no(fs.exists(dir .. "\\tree"), "source folder gone")
end

function tests.list_size_and_missing(t)
    local fs = Fs.new(nil)
    local dir = t.support.temp_dir("ls")
    t.support.write(dir .. "\\b.txt", "12345")
    t.support.write(dir .. "\\a.txt", "1")
    local names = fs.list(dir)
    table.sort(names)
    t:eq(#names, 2, "two entries")
    t:eq(names[1], "a.txt")
    t:eq(fs.size(dir .. "\\b.txt"), 5, "size")
    t:eq(fs.size(dir .. "\\nope.txt"), nil, "size of missing")
    t:eq(#fs.list(dir .. "\\nope"), 0, "list of missing is empty")
    t:no(fs.is_dir(dir .. "\\a.txt"), "file is not a dir")
end

function tests.write_atomic_replaces(t)
    local fs = Fs.new(nil)
    local dir = t.support.temp_dir("wa")
    local path = dir .. "\\m.json"
    t:ok(fs.write_atomic(path, "one"))
    t:ok(fs.write_atomic(path, "two"))
    t:eq(fs.read(path), "two")
    t:no(fs.exists(path .. ".tmp"), "no temp file left")
end

function tests.tree_stats_and_copy_tree(t)
    local fs = Fs.new(nil)
    local dir = t.support.temp_dir("tr")
    fs.mkdirs(dir .. "\\src\\sub")
    t.support.write(dir .. "\\src\\a.txt", "12")
    t.support.write(dir .. "\\src\\sub\\b.txt", "345")
    local bytes, count = fs.tree_stats(dir .. "\\src")
    t:eq(bytes, 5, "bytes")
    t:eq(count, 2, "count")
    t:ok(fs.copy_tree(dir .. "\\src", dir .. "\\dst"))
    t:eq(fs.read(dir .. "\\dst\\sub\\b.txt"), "345")
    t:ok(fs.exists(dir .. "\\src\\a.txt"), "source kept")
end

function tests.native_functions_are_preferred(t)
    local calls = {}
    local native = {
        MakeDirs = function(p) calls[#calls + 1] = "MakeDirs " .. p return true end,
        Move = function(a, b) calls[#calls + 1] = "Move" return true end,
        ListDir = function(p) return "x.txt\ny.txt" end,
        FileSize = function(p) return 42 end,
        IsDir = function(p) return true end,
        TreeStats = function(p) return "100 3" end,
    }
    local fs = Fs.new(native)
    t:ok(fs.mkdirs("C:\\any"))
    t:ok(fs.move("a", "b"))
    t:eq(#fs.list("C:\\any"), 2)
    t:eq(fs.size("C:\\any\\x.txt"), 42)
    local bytes, count = fs.tree_stats("C:\\any")
    t:eq(bytes, 100)
    t:eq(count, 3)
    t:eq(calls[1], "MakeDirs C:\\any")
    t:eq(calls[2], "Move")
end

function tests.native_error_is_returned_not_raised(t)
    local fs = Fs.new({ Move = function() return nil, "locked" end })
    local ok, err = fs.move("a", "b")
    t:no(ok)
    t:eq(err, "locked")
end

return tests
