local MOD_NAME = "Unbalanced"
local count = 0

print(MOD_NAME)

-- The block below is never closed.
function broken(value)
  if value then
    count = count + 1
  end
  print(count)
