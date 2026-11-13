-- GmfDumper settings. Delete a line to get its default back.
return {
    -- Automatic run: the mod starts a dump by itself after the game starts.
    --   mode           "once"   run on the next game start, then never again until the file
    --                           Mods\GmfDumper\auto_run_done.txt is deleted
    --                  "always" run on every game start
    --                  "off"    only run on the command or the key
    --   delay_seconds  how long to wait after the mod loads. The run then also waits until
    --                  the game has a local player, so the main menu is normally reached.
    --   freeze_input   stop player movement and camera input during the automatic run
    --   quit_when_done close the game when the automatic run has finished
    -- The automatic run uses default_profile below. It dumps whatever map is loaded at that
    -- moment, normally the main menu. For the actors of a specific level, set mode to "off",
    -- load the level and use the key or the command.
    --
    -- When the run starts: after delay_seconds, the mod waits until the same map has been
    -- loaded for settle_seconds and that map is not a startup screen.
    --   settle_seconds    how long the map must stay the same
    --   skip_maps         a map whose path contains one of these words is never used.
    --                     Case does not matter.
    --   wait_for_map      when not empty, wait for a map whose path contains this text,
    --                     for example "Lobby"
    --   max_wait_seconds  after this long the run starts on whatever map is loaded
    auto_run = {
        mode = "once", delay_seconds = 15, freeze_input = true, quit_when_done = true,
        settle_seconds = 10, max_wait_seconds = 300, wait_for_map = "",
        skip_maps = { "shader", "loading", "startup", "splash", "intro", "logo" },
    },

    -- What the full profile loads before it dumps, and when it stops.
    --   mode  "data"  every asset except bulk content: textures, meshes, sounds, animations,
    --                 materials, effects and maps. This brings in every Blueprint class,
    --                 data table, data asset, enum, struct and widget, which is what the
    --                 dumps describe, at a fraction of the memory.
    --         "all"   every asset. Needs much more memory.
    --   min_free_memory_gb  loading stops when less than this much physical memory is
    --                 available on the machine. What was loaded up to then is still dumped.
    load_assets = { mode = "data", min_free_memory_gb = 1.5 },

    -- Levels: after a full run, load each map of the game as data and dump the actors
    -- saved in it into Levels\<MapName> (actors.json and actor_values.jsonl). The game
    -- does not travel to the map, so no game code runs for it and it cannot crash the way
    -- opening a map can. It shows each level as built, not a match in progress.
    --   enabled        false turns this off
    --   maps           "auto": every map outside the engine's content whose path has none
    --                  of the words in `exclude`. Or a list of map paths.
    --   exclude        words that rule a map out in "auto" mode. Case does not matter.
    --   pause_seconds  pause after each map, in which the engine frees its memory
    -- Levels\levels.json lists each map with its result.
    levels = { enabled = true, maps = "auto", exclude = {}, pause_seconds = 1 },

    -- Map tour, off by default: after a full run, open each map of the game in turn and
    -- dump its level into World\<MapName> (actors, meshes, transforms, values, runtime
    -- context). Opening a map runs the game's own code for it, and some games crash on
    -- maps that are not meant to be opened without a session. Turn it on only when the
    -- level dump above is not enough.
    --   enabled           true turns the tour on
    --   maps              "auto": every map in a folder named Maps, outside the engine's
    --                     content, whose path has none of the words in `exclude`.
    --                     Or a list of map paths, for example
    --                     { "/Game/StormEscape/Maps/Lobby" }.
    --   exclude           words that rule a map out in "auto" mode. Case does not matter.
    --   settle_seconds    how long a map must have been loaded before it is dumped
    --   max_wait_seconds  how long to wait for a map before moving on to the next
    -- A map opened this way loads without a game session, so it shows the level as built,
    -- not a match in progress, and a game mode that needs a session may misbehave. The
    -- tour runs last, after every other dump is saved. World\map_tour.json lists each map
    -- with its result; a map that crashed the game is the one still marked "running".
    map_tour = {
        enabled = false, maps = "auto", settle_seconds = 6, max_wait_seconds = 180,
        exclude = { "developers", "mockup", "shader", "loading", "startup", "splash", "intro", "logo", "entry", "scene" },
    },

    -- Profile run by the automatic run, the bare "gmfdump" command and the key bind.
    --   "full"  loads every asset first. Most complete; needs several GB of memory, and the
    --           game should be restarted afterwards.
    --   "quick" dumps only what is loaded right now.
    default_profile = "full",

    -- Key names are the ones in Mods\shared\Types.lua (Key and ModifierKey).
    keybind = { key = "NUM_ZERO", modifiers = { "CONTROL" } },

    -- Where run folders are created. Relative to the ue4ss folder, or an absolute path.
    output_root = "Dumps",

    -- Include Blueprint-generated classes, structs and enums in the .usmap and .jmap.
    include_blueprint_types = true,

    -- Leave property values out of the .jmap. Smaller file, less information.
    jmap_skip_property_values = false,

    -- Backend for the BP SDK generator.
    bpsdk_backend = "UE4SS",

    -- Also copy the Lua types to Mods\shared\types, where editors expect them.
    also_write_shared_lua_types = true,

    -- Step ids to leave out of every profile, for example { "uht", "bpsdk" }.
    -- "gmfdump list" prints the ids.
    disabled_steps = {},
}
