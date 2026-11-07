"""gmf helper around the UnityPy library (UnityPy has no inspect or replace CLI).

  python gmf_unitypy.py inspect <asset-file> --output <metadata.json>
  python gmf_unitypy.py replace <asset-file> --object <path-id|name> --from <file> --output <new-asset-file>

inspect writes {"file", "unitypy", "objects": [{"pathId", "type", "name", "container"}]}.
replace never writes the input file: it writes the changed asset file to --output.
  Texture2D or Sprite texture: --from is an image (needs Pillow).
  TextAsset: --from is any file; its bytes become the text asset.
  Any type with a type tree: --from is a .json object; its keys replace the tree's keys.
  Otherwise: --from is raw object data.
It prints one JSON line describing what it did.
"""

import argparse
import json
import os
import sys

import UnityPy


def object_name(obj):
    peek = getattr(obj, "peek_name", None)
    if callable(peek):
        try:
            return peek()
        except Exception:
            pass
    try:
        data = parse(obj)
        return getattr(data, "m_Name", None)
    except Exception:
        return None


def parse(obj):
    reader = getattr(obj, "parse_as_object", None) or obj.read
    return reader()


def containers(env):
    found = {}
    try:
        for path, obj in env.container.items():
            pointer = getattr(obj, "path_id", None)
            if pointer is None and hasattr(obj, "m_PathID"):
                pointer = obj.m_PathID
            if pointer is not None:
                found[int(pointer)] = path
    except Exception:
        pass
    return found


def inspect(args):
    env = UnityPy.load(args.asset)
    paths = containers(env)
    objects = []
    for obj in env.objects:
        objects.append(
            {
                "pathId": int(obj.path_id),
                "type": obj.type.name,
                "name": object_name(obj),
                "container": paths.get(int(obj.path_id)),
            }
        )
    report = {"file": os.path.abspath(args.asset), "unitypy": UnityPy.__version__, "objects": objects}
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({"ok": True, "objects": len(objects), "output": args.output}))


def find_object(env, key):
    matches = []
    for obj in env.objects:
        if str(obj.path_id) == key or object_name(obj) == key:
            matches.append(obj)
    if not matches:
        raise SystemExit(f"no object with path id or name {key!r}")
    if len(matches) > 1:
        ids = ", ".join(f"{m.path_id} ({m.type.name})" for m in matches)
        raise SystemExit(f"{key!r} matches several objects; pass a path id: {ids}")
    return matches[0]


def replace(args):
    env = UnityPy.load(args.asset)
    obj = find_object(env, args.object)
    kind = obj.type.name
    source = args.source
    if kind in ("Texture2D", "Sprite"):
        from PIL import Image

        data = parse(obj)
        texture = data.m_RD.texture.read() if kind == "Sprite" else data
        texture.image = Image.open(source)
        texture.save()
        method = "image"
    elif kind == "TextAsset":
        data = parse(obj)
        with open(source, "rb") as handle:
            raw = handle.read()
        try:
            data.m_Script = raw.decode("utf-8", "surrogateescape")
        except Exception:
            data.m_Script = raw
        data.save()
        method = "text"
    elif source.lower().endswith(".json"):
        with open(source, "r", encoding="utf-8") as handle:
            changes = json.load(handle)
        tree = obj.read_typetree()
        tree.update(changes)
        obj.save_typetree(tree)
        method = "typetree"
    else:
        with open(source, "rb") as handle:
            obj.set_raw_data(handle.read())
        method = "raw"
    with open(args.output, "wb") as handle:
        handle.write(env.file.save())
    print(json.dumps({"ok": True, "pathId": int(obj.path_id), "type": kind, "method": method, "output": args.output}))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gmf_unitypy")
    sub = parser.add_subparsers(dest="command", required=True)
    p_inspect = sub.add_parser("inspect")
    p_inspect.add_argument("asset")
    p_inspect.add_argument("--output", required=True)
    p_replace = sub.add_parser("replace")
    p_replace.add_argument("asset")
    p_replace.add_argument("--object", required=True)
    p_replace.add_argument("--from", dest="source", required=True)
    p_replace.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    if args.command == "inspect":
        inspect(args)
    else:
        replace(args)


if __name__ == "__main__":
    sys.exit(main())
