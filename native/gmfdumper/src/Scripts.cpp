#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <cstring>
#include <set>

#include <DynamicOutput/DynamicOutput.hpp>
#include <Unreal/UObjectGlobals.hpp>

namespace GmfDumper
{
    namespace
    {
        // Walks Kismet bytecode far enough to find the names in it. In memory a name is an
        // index into the engine's name table, and a name that only bytecode uses, such as
        // a material parameter, appears in no other dump. A tool that reads the bytes
        // later has no game to ask, so the names are resolved here.
        //
        // The opcode sizes are the engine's EExprToken for Unreal Engine 5, the same table
        // tools/kismet.py uses. A function that does not walk to exactly its end is left
        // out: an index read from the wrong place must never be looked up.
        class ScriptWalker
        {
          public:
            ScriptWalker(const uint8_t* data, size_t size, std::vector<uint32_t>& names) : m_data(data), m_size(size), m_names(names)
            {
            }

            auto walk() -> bool
            {
                bool ended{};
                while (m_ok && m_pos < m_size)
                {
                    if (expr() == 0x53)
                    {
                        ended = true;
                        break;
                    }
                }
                return m_ok && ended && m_pos == m_size;
            }

          private:
            auto skip(size_t count) -> void
            {
                if (m_pos + count > m_size)
                {
                    m_ok = false;
                    return;
                }
                m_pos += count;
            }

            auto byte() -> uint8_t
            {
                if (m_pos >= m_size)
                {
                    m_ok = false;
                    return 0;
                }
                return m_data[m_pos++];
            }

            auto name() -> void
            {
                if (m_pos + 12 > m_size)
                {
                    m_ok = false;
                    return;
                }
                uint32_t index{};
                std::memcpy(&index, m_data + m_pos, sizeof(index));
                m_pos += 12;
                m_names.push_back(index);
            }

            auto until(uint8_t end) -> void
            {
                while (m_ok)
                {
                    if (m_pos >= m_size)
                    {
                        m_ok = false;
                        return;
                    }
                    if (m_data[m_pos] == end)
                    {
                        ++m_pos;
                        return;
                    }
                    expr();
                }
            }

            auto ansi() -> void
            {
                while (m_ok && byte() != 0)
                {
                }
            }

            auto utf16() -> void
            {
                while (m_ok)
                {
                    uint8_t low = byte();
                    uint8_t high = byte();
                    if (low == 0 && high == 0)
                    {
                        return;
                    }
                }
            }

            auto text() -> void
            {
                switch (byte())
                {
                case 0:
                case 0xFF:
                    return;
                case 1:
                    expr();
                    expr();
                    expr();
                    return;
                case 2:
                case 3:
                    expr();
                    return;
                case 4:
                    skip(8);
                    expr();
                    expr();
                    return;
                default:
                    m_ok = false;
                }
            }

            auto expr() -> uint8_t
            {
                if (!m_ok || ++m_depth > 400)
                {
                    m_ok = false;
                    return 0;
                }
                const uint8_t op = byte();
                switch (op)
                {
                case 0x00: case 0x48: case 0x01: case 0x02: case 0x6C: case 0x20: case 0x33:
                    skip(8);
                    break;
                case 0x04: case 0x4E: case 0x4F: case 0x51: case 0x5D: case 0x67: case 0x6D:
                    expr();
                    break;
                case 0x06: case 0x0C: case 0x1D: case 0x1E: case 0x4C: case 0x5B:
                    skip(4);
                    break;
                case 0x07: case 0x18:
                    skip(4);
                    expr();
                    break;
                case 0x09:
                    skip(3);
                    expr();
                    break;
                case 0x0B: case 0x15: case 0x17: case 0x25: case 0x26: case 0x27: case 0x28: case 0x2A: case 0x2D:
                case 0x4D: case 0x50: case 0x5A: case 0x5E: case 0x53:
                    break;
                case 0x0F:
                    skip(8);
                    expr();
                    expr();
                    break;
                case 0x14: case 0x43: case 0x44: case 0x5F: case 0x60: case 0x5C: case 0x62: case 0x6B:
                    expr();
                    expr();
                    break;
                case 0x11:
                    skip(9);
                    break;
                case 0x12: case 0x19: case 0x1A:
                    expr();
                    skip(12);
                    expr();
                    break;
                case 0x13: case 0x2E: case 0x52: case 0x54: case 0x55: case 0x42: case 0x64:
                    skip(8);
                    expr();
                    break;
                case 0x1B: case 0x45:
                    name();
                    until(0x16);
                    break;
                case 0x1C: case 0x46: case 0x68:
                    skip(8);
                    until(0x16);
                    break;
                case 0x1F:
                    ansi();
                    break;
                case 0x21: case 0x4B:
                    name();
                    break;
                case 0x22: case 0x23:
                    skip(24);
                    break;
                case 0x41:
                    skip(12);
                    break;
                case 0x24: case 0x2C:
                    skip(1);
                    break;
                case 0x29:
                    text();
                    break;
                case 0x2B:
                    skip(80);
                    break;
                case 0x2F:
                    skip(12);
                    until(0x30);
                    break;
                case 0x31:
                    expr();
                    until(0x32);
                    break;
                case 0x34:
                    utf16();
                    break;
                case 0x35: case 0x36: case 0x37:
                    skip(8);
                    break;
                case 0x38:
                    skip(1);
                    expr();
                    break;
                case 0x39:
                    expr();
                    skip(4);
                    until(0x3A);
                    break;
                case 0x3B:
                    expr();
                    skip(4);
                    until(0x3C);
                    break;
                case 0x3D:
                    skip(12);
                    until(0x3E);
                    break;
                case 0x3F:
                    skip(20);
                    until(0x40);
                    break;
                case 0x61:
                    name();
                    expr();
                    expr();
                    break;
                case 0x63:
                    skip(8);
                    expr();
                    until(0x16);
                    break;
                case 0x65:
                    skip(12);
                    until(0x66);
                    break;
                case 0x69:
                {
                    uint8_t low = byte();
                    uint8_t high = byte();
                    const size_t count = static_cast<size_t>(low) | (static_cast<size_t>(high) << 8);
                    skip(4);
                    expr();
                    for (size_t i = 0; m_ok && i < count; ++i)
                    {
                        expr();
                        skip(4);
                        expr();
                    }
                    expr();
                    break;
                }
                case 0x6A:
                    if (byte() == 4)
                    {
                        name();
                    }
                    break;
                default:
                    m_ok = false;
                }
                --m_depth;
                return op;
            }

            const uint8_t* m_data;
            size_t m_size;
            size_t m_pos{};
            std::vector<uint32_t>& m_names;
            int m_depth{};
            bool m_ok{true};
        };
    } // namespace

    // Writes the Blueprint bytecode of every function and struct that has any, one JSON
    // object per line: path, type, size and the bytes as base64. The bytes are the raw
    // Kismet bytecode as it sits in memory; disassembling them is a job for an external
    // tool.
    auto dump_scripts(const std::filesystem::path& file) -> void
    {
        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        auto out = open_text_file(file);
        PathCache paths{};
        MemoryChecker memory{};
        size_t written{};
        size_t unreadable{};
        size_t not_walked{};
        std::set<uint32_t> name_indices{};

        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || *reinterpret_cast<uint64_t*>(object) == 0)
            {
                return LoopAction::Continue;
            }
            UClass* object_class = object->GetClassPrivate();
            if (!object_class || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            uint64_t cast_flags = object_class->GetClassCastFlags();
            if ((cast_flags & CASTCLASS_UStruct) == 0)
            {
                return LoopAction::Continue;
            }
            try
            {
                auto& script = static_cast<UStruct*>(object)->GetScript();
                auto size = static_cast<size_t>(script.Num());
                if (script.Num() <= 0 || !script.GetData())
                {
                    return LoopAction::Continue;
                }
                if (!memory.is_readable(script.GetData(), size))
                {
                    ++unreadable;
                    return LoopAction::Continue;
                }
                const char* type = (cast_flags & CASTCLASS_UFunction) != 0 ? "Function" : (cast_flags & CASTCLASS_UClass) != 0 ? "Class" : "Struct";
                out << "{\"path\":\"" << json_escape(paths.path_of(object)) << "\",\"type\":\"" << type << "\",\"size\":" << size << ",\"script\":\""
                    << base64_encode(reinterpret_cast<const uint8_t*>(script.GetData()), size) << "\"}\n";
                ++written;
                if ((cast_flags & CASTCLASS_UFunction) != 0)
                {
                    std::vector<uint32_t> found{};
                    ScriptWalker walker{reinterpret_cast<const uint8_t*>(script.GetData()), size, found};
                    if (walker.walk())
                    {
                        name_indices.insert(found.begin(), found.end());
                    }
                    else
                    {
                        ++not_walked;
                    }
                }
            }
            catch (...)
            {
                ++unreadable;
            }
            return LoopAction::Continue;
        });

        // The last line: the text of every name the functions above refer to by index.
        out << "{\"type\":\"Names\",\"note\":\"name index to text, for the names the scripts above use\",\"names\":{";
        size_t names_written{};
        for (uint32_t index : name_indices)
        {
            std::string text{};
            try
            {
                text = name_to_utf8(FName{index, 0u});
            }
            catch (...)
            {
                continue;
            }
            out << (names_written ? "," : "") << "\"" << index << "\":\"" << json_escape(text) << "\"";
            ++names_written;
        }
        out << "}}\n";

        out.flush();
        if (!out)
        {
            throw std::runtime_error{"write failed: " + path_to_utf8(file)};
        }
        Output::send(STR("[GmfDumper] scripts: {} written, {} unreadable, {} names, {} functions not walked for names\n"),
                     written,
                     unreadable,
                     names_written,
                     not_walked);
    }
} // namespace GmfDumper
