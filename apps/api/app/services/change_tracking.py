"""Helpers the routes share to describe a write in a change notification."""

Tree = dict[str, tuple[str, str | None]]


def changed_values(row, changes: dict) -> dict:
    """The values `changes` actually alters, as they were before the write."""
    return {k: getattr(row, k) for k, v in changes.items() if getattr(row, k) != v}


def tree_path(node_id: str, name: str, parent_id: str | None, tree: Tree) -> str:
    """`name` prefixed by its folders, from `tree` = {id: (name, parent_id)}.
    Stops on a cycle rather than looping."""
    parts, seen, current = [name], {node_id}, parent_id
    while current is not None and current in tree and current not in seen:
        seen.add(current)
        parent_name, current = tree[current]
        parts.append(parent_name)
    return "/".join(reversed(parts))


def file_detail(action: str, path: str, kind: str, file_id: str) -> dict:
    """The `detail` fields naming one file of a script tree (ETL, SQL collection)."""
    return {
        "part": "folder" if kind == "folder" else "script",
        "action": action,
        "name": path,
        "fileId": file_id,
    }
