#pragma once

// Helpers shared by the native dumpers: path and string conversion, object paths, a
// memory readability check, and a streaming JSON writer.

#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <Helpers/String.hpp>
#include <Unreal/CoreUObject/UObject/Class.hpp>
#include <Unreal/NameTypes.hpp>
#include <Unreal/UObject.hpp>
#include <Unreal/UnrealFlags.hpp>

#define GMFDUMPER_VERSION "0.1.0"
#define GMFDUMPER_VERSION_W L"0.1.0"

namespace GmfDumper
{
    using namespace ::RC;
    using namespace ::RC::Unreal;

    // Lua hands paths over as UTF-8.
    inline auto to_path(std::string_view utf8) -> std::filesystem::path
    {
        return std::filesystem::path{std::u8string_view{reinterpret_cast<const char8_t*>(utf8.data()), utf8.size()}};
    }

    inline auto path_to_utf8(const std::filesystem::path& path) -> std::string
    {
        auto text = path.u8string();
        return std::string{reinterpret_cast<const char*>(text.data()), text.size()};
    }

    inline auto name_to_utf8(FName name) -> std::string
    {
        return to_utf8_string(name.ToString());
    }

    inline auto hex(uint64_t value) -> std::string
    {
        char buffer[32];
        std::snprintf(buffer, sizeof(buffer), "0x%llX", static_cast<unsigned long long>(value));
        return buffer;
    }

    // True for class default objects and archetypes, which describe defaults, not types.
    inline auto is_default_object(UObject* object) -> bool
    {
        return (static_cast<uint32_t>(object->GetObjectFlags()) & (RF_ClassDefaultObject | RF_ArchetypeObject)) != 0;
    }

    // Builds object paths in the form UE4SS's RegisterHook and the .jmap format use:
    // "." after a package, ":" after anything else, for example
    // /Script/Engine.Actor:ReceiveBeginPlay
    class PathCache
    {
      public:
        auto path_of(UObject* object) -> const std::string&
        {
            if (auto it = m_cache.find(object); it != m_cache.end())
            {
                return it->second;
            }
            std::string name = name_to_utf8(object->GetNamePrivate());
            std::string path{};
            if (UObject* outer = object->GetOuterPrivate())
            {
                const std::string& outer_path = path_of(outer);
                UClass* outer_class = outer->GetClassPrivate();
                bool outer_is_package = outer_class && (outer_class->GetClassCastFlags() & CASTCLASS_UPackage) != 0;
                path.reserve(outer_path.size() + 1 + name.size());
                path.append(outer_path);
                path.push_back(outer_is_package ? '.' : ':');
                path.append(name);
            }
            else
            {
                path = std::move(name);
            }
            return m_cache.emplace(object, std::move(path)).first->second;
        }

      private:
        std::unordered_map<const UObject*, std::string> m_cache{};
    };

    // Answers whether a memory range can be read, caching VirtualQuery results per region.
    class MemoryChecker
    {
      public:
        auto is_readable(const void* address, size_t size = 1) -> bool;

      private:
        struct Region
        {
            uint64_t base{};
            uint64_t end{};
            bool readable{};
        };
        auto query(uint64_t address) -> const Region*;
        std::map<uint64_t, Region> m_regions{};
    };

    // True when `object` points at a UObject the engine's object array still holds. A pointer
    // read out of a property value can be stale or garbage; dereferencing it would crash the
    // game, and a C++ catch block does not stop an access violation.
    auto is_live_object(MemoryChecker& memory, UObject* object) -> bool;

    auto base64_encode(const uint8_t* data, size_t size) -> std::string;

    // Escapes a string for use inside JSON quotes.
    auto json_escape(std::string_view text) -> std::string;

    // Writes JSON straight to a file, so a dump of every class never sits in memory.
    // Arrays opened with `one_per_line` put each element on its own line, which keeps the
    // files readable in an editor and friendly to line-based tools.
    class JsonWriter
    {
      public:
        explicit JsonWriter(const std::filesystem::path& path);
        ~JsonWriter();

        // A writer that produces nothing. Running a piece of output code against it first
        // shows whether that code throws, before anything reaches a real file.
        struct Discard
        {
        };
        explicit JsonWriter(Discard);
        // Forgets any unfinished objects and arrays. Only meaningful for a discarding writer.
        auto reset() -> void;

        JsonWriter(const JsonWriter&) = delete;
        auto operator=(const JsonWriter&) -> JsonWriter& = delete;

        auto begin_object() -> void;
        auto end_object() -> void;
        auto begin_array(bool one_per_line = false) -> void;
        auto end_array() -> void;
        auto key(std::string_view name) -> void;

        auto value(std::string_view text) -> void;
        auto value(const std::string& text) -> void { value(std::string_view{text}); }
        auto value(const char* text) -> void { value(std::string_view{text}); }
        auto value(int64_t number) -> void;
        auto value(uint64_t number) -> void;
        auto value(int32_t number) -> void { value(static_cast<int64_t>(number)); }
        auto value(uint32_t number) -> void { value(static_cast<uint64_t>(number)); }
        auto value(double number) -> void;
        // Written with float precision, so 0.1f reads 0.1 and not 0.10000000149011612.
        auto value(float number) -> void;
        auto value(bool flag) -> void;
        auto null() -> void;
        // Ends the current line. Used between the top-level values of a .jsonl file.
        auto line_break() -> void;

        template <typename T>
        auto field(std::string_view name, T&& item) -> void
        {
            key(name);
            value(std::forward<T>(item));
        }

        auto null_field(std::string_view name) -> void
        {
            key(name);
            null();
        }

        auto string_array(std::string_view name, const std::vector<std::string>& items) -> void
        {
            key(name);
            begin_array();
            for (const auto& item : items)
            {
                value(item);
            }
            end_array();
        }

        // Flushes and closes the file. Throws when any write failed.
        auto close() -> void;

      private:
        struct Level
        {
            bool is_array{};
            bool one_per_line{};
            bool has_items{};
        };
        auto before_value() -> void;
        auto write(std::string_view text) -> void;
        auto write_escaped(std::string_view text) -> void;

        std::ofstream m_out{};
        std::string m_buffer{};
        std::vector<Level> m_levels{};
        std::filesystem::path m_path{};
        bool m_after_key{};
        bool m_closed{};
        bool m_discard{};
        // The last character written, to avoid ending a file with two line breaks.
        char m_last{};
    };

    // Opens a text file for writing and throws when that fails.
    auto open_text_file(const std::filesystem::path& path) -> std::ofstream;
} // namespace GmfDumper
