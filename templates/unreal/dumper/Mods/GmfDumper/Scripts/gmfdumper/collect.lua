-- Collects the output of UE4SS's built-in dumpers. They write to fixed places with fixed
-- or timestamped names, so a step runs the dumper and then moves what it produced into
-- the run folder.

local collect = {}

local ASIDE = ".gmf-aside"

-- Path relative to the run folder, with forward slashes, as stored in the manifest.
function collect.relative(run_dir, path)
    local rel = path
    if path:sub(1, #run_dir):lower() == run_dir:lower() then
        rel = path:sub(#run_dir + 1)
    end
    rel = rel:gsub("\\", "/"):gsub("^/+", "")
    return rel
end

-- Manifest entry for a file or folder that is already inside the run folder.
function collect.entry(fs, run_dir, path)
    if not fs.exists(path) then
        return nil
    end
    if fs.is_dir(path) then
        local bytes, count = fs.tree_stats(path)
        return { path = collect.relative(run_dir, path), bytes = bytes, count = count, dir = true }
    end
    return { path = collect.relative(run_dir, path), bytes = fs.size(path) or 0 }
end

-- Entries for the given paths. Fails when none of them exists.
function collect.entries(fs, run_dir, paths)
    local files = {}
    for _, path in ipairs(paths) do
        local entry = collect.entry(fs, run_dir, path)
        if entry then
            files[#files + 1] = entry
        end
    end
    if #files == 0 then
        return nil, "no output found"
    end
    return files
end

-- Runs `produce`, then moves every entry of `source_dir` accepted by `matcher` into
-- `dest_dir`. `rename`, when given, maps a produced name to its name in dest_dir.
--
-- Entries that matched before the call belong to the user or to an older run. They are
-- moved aside first and put back afterwards, so a dumper that writes nothing is reported
-- as "no output found" instead of an old file being collected as new.
function collect.capture(fs, run_dir, source_dir, matcher, dest_dir, produce, rename)
    -- A game crash inside an earlier capture leaves files under their aside name. Put
    -- those back first, so they are treated like any other pre-existing file.
    for _, name in ipairs(fs.list(source_dir)) do
        local original = name:match("^(.*)%.gmf%-aside%d*$")
        if original and matcher(original) and not fs.exists(source_dir .. "\\" .. original) then
            fs.move(source_dir .. "\\" .. name, source_dir .. "\\" .. original)
        end
    end

    local aside = {}
    for _, name in ipairs(fs.list(source_dir)) do
        if matcher(name) then
            local from = source_dir .. "\\" .. name
            -- Never reuse an aside name that exists: moving onto it would destroy that file.
            local target, n = from .. ASIDE, 1
            while fs.exists(target) do
                n = n + 1
                target = from .. ASIDE .. n
            end
            if fs.move(from, target) then
                aside[#aside + 1] = { original = from, aside = target }
            end
        end
    end

    local function restore()
        for _, item in ipairs(aside) do
            if not fs.exists(item.original) then
                fs.move(item.aside, item.original)
            end
        end
    end

    local ok, err = pcall(produce)

    local produced = {}
    for _, name in ipairs(fs.list(source_dir)) do
        if matcher(name) then
            produced[#produced + 1] = name
        end
    end
    table.sort(produced)

    local files, move_err = {}, nil
    if #produced > 0 then
        local made, mk_err = fs.mkdirs(dest_dir)
        if not made then
            move_err = mk_err
        else
            for _, name in ipairs(produced) do
                local target = dest_dir .. "\\" .. (rename and rename(name) or name)
                local moved, why = fs.move(source_dir .. "\\" .. name, target)
                if moved then
                    files[#files + 1] = collect.entry(fs, run_dir, target)
                else
                    move_err = "could not move " .. name .. ": " .. tostring(why)
                end
            end
        end
    end

    restore()

    if not ok then
        return nil, tostring(err)
    end
    if move_err then
        return nil, move_err
    end
    if #files == 0 then
        return nil, "no output found"
    end
    return files
end

function collect.name_is(expected)
    local lowered = expected:lower()
    return function(name)
        return name:lower() == lowered
    end
end

function collect.name_matches(pattern)
    return function(name)
        return name:lower():find(pattern) ~= nil
    end
end

return collect
