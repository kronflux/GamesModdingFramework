-- Don't let an apostrophe in a comment open a string.
local U = {}

function U.valid(value)
  if value == nil then
    return false
  end
  local text = "it's [not] a (bracket) problem: function if do"
  return #text > 0 and type(value) == 'string'
end

function U.each(list, fn)
  for _, item in ipairs(list) do
    fn(item)
  end
  local i = 0
  while i < 2 do i = i + 1 end
  repeat i = i - 1 until i <= 0
  --[[ long comment with an unmatched ( and the word end ]]
  return [==[long string ( with end ]==]
end

return U
