"""Slash-command definitions, matching, and parsing.

This module deliberately has no GTK dependency so command behavior can be
tested without a running display.
"""

import shlex


COMMANDS = [
    {
        "name": "status",
        "description": "Show gateway status and current model",
        "usage": "/status",
        "takes_args": False,
    },
    {
        "name": "model",
        "description": "View or change the current AI model",
        "usage": "/model [list|<number>]",
        "takes_args": True,
    },
    {
        "name": "models",
        "description": "Open the searchable model picker",
        "usage": "/models [search]",
        "takes_args": True,
    },
    {
        "name": "think",
        "description": "Choose the current model's thinking level",
        "usage": "/think",
        "takes_args": False,
    },
    {
        "name": "session",
        "description": "Show session info and stats",
        "usage": "/session",
        "takes_args": False,
    },
    {
        "name": "new",
        "description": "Archive session and start fresh",
        "usage": "/new",
        "takes_args": False,
    },
    {
        "name": "task",
        "description": "Manage scheduled background tasks",
        "usage": "/task [list|add|<id> ...]",
        "takes_args": True,
    },
    {
        "name": "clear",
        "description": "Clear this chat view",
        "usage": "/clear",
        "takes_args": False,
    },
]


def fuzzy_score(query, command):
    """Return a sortable relevance score, or ``None`` for no match."""
    query = query.lower()
    name = command["name"].lower()
    description = command["description"].lower()
    if not query or query == name:
        return (0, 0, 0)
    if name.startswith(query):
        return (1, len(name) - len(query), 0)
    if query in name:
        return (2, name.index(query), 0)

    positions = []
    cursor = 0
    for char in query:
        position = name.find(char, cursor)
        if position < 0:
            break
        positions.append(position)
        cursor = position + 1
    else:
        gaps = positions[-1] - positions[0] + 1 - len(positions)
        return (3, gaps, positions[0])

    if query in description:
        return (4, description.index(query), 0)
    return None


def matching_commands(text, commands=COMMANDS):
    """Return suggestions for a command token at the start of ``text``."""
    if not text.startswith("/"):
        return []
    after_slash = text[1:]
    if any(char.isspace() for char in after_slash):
        return []

    matches = []
    for command in commands:
        score = fuzzy_score(after_slash, command)
        if score is not None:
            matches.append((score, command))
    matches.sort(key=lambda item: item[0])
    return [command for _score, command in matches]


def parse_command(text):
    """Parse ``/command [args]`` using shell-like quoting.

    Raises ``ValueError`` for invalid quoting and returns ``None`` when no
    command token is present.
    """
    parts = shlex.split(text[1:] if text.startswith("/") else text)
    if not parts:
        return None
    return parts[0].lower(), parts[1:]
