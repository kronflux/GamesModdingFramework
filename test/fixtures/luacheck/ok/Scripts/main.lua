local MOD_NAME = "OkMod"
local U = require("util")
local Shared = require("UEHelpers")

if U.valid(MOD_NAME) then
  print(MOD_NAME)
end
U.each({ 1, 2 }, function(item) print(item) end)
