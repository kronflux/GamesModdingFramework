--[[
    core/help.lua — command registry + the `help` console command.

    Every command this mod registers should go through the SAME registry
    (Help.NewRegistry()'s Registry.Register), whether it's registered directly
    by main.lua (e.g. `selftest`) or indirectly through a features/*.lua
    module's M.register(ctx) via ctx.register_command (see main.lua's features
    loader, which wires ctx.register_command to Registry.Register). That is
    what keeps `help`'s listing accurate: there is exactly one place a command
    gets recorded, so there is nothing for a second hand-maintained list to
    drift out of sync with.

    UE4SS Lua API used (see RE-UE4SS/docs/lua-api/):
      - global-functions/registerconsolecommandhandler.md -> RegisterConsoleCommandHandler
      - global-functions/print.md                          -> print
]]

local Help = {}

local DEFAULT_DESCRIPTION = "(no description provided)"

---Creates a fresh, empty command registry. Every mod built from this template
---creates exactly one (see main.lua), then threads it through everything that
---registers a console command: main.lua's own commands, this module's `help`
---command, and every wired features/*.lua and systems/dev.lua module (via
---ctx.register_command).
---@return table Registry
function Help.NewRegistry()
    local Registry = { Commands = {} }

    ---Registers Name as a real UE4SS console command AND records it (with
    ---Description) so `help` can list it later. Always go through this
    ---instead of calling RegisterConsoleCommandHandler directly, or `help`
    ---silently misses the command.
    ---@param Name string
    ---@param Handler function
    ---@param Description string|nil  # shown by `help`; a caller that can't supply one (e.g. the ctx.register_command adapter used for features/*.lua modules, whose M.register(ctx) contract only passes name+handler) gets a placeholder instead of a blank line.
    function Registry.Register(Name, Handler, Description)
        -- Register first: if UE4SS refuses the handler (it raises), `help` must
        -- not list a command that does not exist.
        RegisterConsoleCommandHandler(Name, Handler)
        table.insert(Registry.Commands, { Name = Name, Description = Description or DEFAULT_DESCRIPTION })
    end

    return Registry
end

---Registers a `help` command against Registry that lists every command
---registered into Registry so far. Register this LAST (after every other
---Registry.Register call in main.lua, and after the features loader has run)
---so `help`'s own listing is complete — it reads Registry.Commands at
---call-time, though, so even a command registered after `help` itself would
---still show up the next time `help` runs.
---@param Registry table  # from Help.NewRegistry()
---@param CommandName string|nil  # defaults to "help"
function Help.Register(Registry, CommandName)
    CommandName = CommandName or "help"

    local function RunHelp(FullCommand, Parameters, OutputDevice)
        local function Emit(Line)
            if OutputDevice ~= nil then OutputDevice:Log(Line) end
            print(Line .. "\n")
        end

        Emit(string.format("[{{name}}] %d available command(s):", #Registry.Commands))
        for _, Command in ipairs(Registry.Commands) do
            Emit(string.format("  %-24s %s", Command.Name, Command.Description))
        end
    end

    Registry.Register(CommandName, function(FullCommand, Parameters, OutputDevice)
        local Ok, Err = pcall(RunHelp, FullCommand, Parameters, OutputDevice)
        if not Ok then
            print(string.format("[{{name}}] %s FAILED: %s\n", CommandName, tostring(Err)))
            if OutputDevice ~= nil then
                OutputDevice:Log(string.format("[{{name}}] %s FAILED: %s", CommandName, tostring(Err)))
            end
        end
        -- true = handled: the engine must not also treat "help" as an unknown command.
        return true
    end, "List this mod's available console commands.")
end

return Help
