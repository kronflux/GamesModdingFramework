-- GmfDumper: dumps every reference artifact UE4SS can reach into one folder.
-- This file only finds the mod folder and hands over to gmfdumper/app.lua. It does no
-- game object work, because UE4SS runs it on its own thread at startup.

local source = debug.getinfo(1, "S").source:gsub("^@", "")
local scripts_dir = source:match("^(.*)[\\/][^\\/]+$") or "."
local mod_dir = scripts_dir:match("^(.*)[\\/][^\\/]+$") or "."

package.path = scripts_dir .. "\\?.lua;" .. scripts_dir .. "\\vendor\\?.lua;" .. package.path

local ok, result = pcall(function()
    return require("gmfdumper.app").install({ api = _G, mod_dir = mod_dir })
end)
if not ok then
    print("[GmfDumper] failed to start: " .. tostring(result) .. "\n")
end
