"""Pure model filtering helpers for the GTK model picker.

Keeping matching independent from GTK makes the fuzzy-finder behavior easy to
exercise in headless tests.
"""


def _subsequence_score(query, candidate):
    """Score a fuzzy subsequence match, or return ``None`` when it misses."""
    positions = []
    cursor = 0
    for char in query:
        position = candidate.find(char, cursor)
        if position < 0:
            return None
        positions.append(position)
        cursor = position + 1

    span = positions[-1] - positions[0] + 1
    gaps = span - len(query)
    return gaps, positions[0], len(candidate)


def fuzzy_model_score(query, model):
    """Return a sortable relevance score for a gateway model dictionary.

    Queries may contain several whitespace-separated terms. Every term must
    match, but may match a different field (for example ``"openai luna"``).
    Contiguous matches rank ahead of subsequence matches.
    """
    terms = query.casefold().split()
    if not terms:
        return (0, 0, 0, 0)

    provider = str(model.get("provider") or "").casefold()
    model_id = str(model.get("id") or "").casefold()
    name = str(model.get("name") or "").casefold()
    canonical = f"{provider}/{model_id}"
    fields = (canonical, model_id, provider, name)

    term_scores = []
    for term in terms:
        best = None
        for field_index, field in enumerate(fields):
            if not field:
                continue
            if field == term:
                score = (0, field_index, 0, len(field))
            elif field.startswith(term):
                score = (1, field_index, len(field) - len(term), len(field))
            elif term in field:
                score = (2, field_index, field.index(term), len(field))
            else:
                fuzzy = _subsequence_score(term, field)
                if fuzzy is None:
                    continue
                score = (3, field_index, *fuzzy)
            if best is None or score < best:
                best = score
        if best is None:
            return None
        term_scores.append(best)

    return (
        max(score[0] for score in term_scores),
        sum(score[0] for score in term_scores),
        sum(score[2] for score in term_scores),
        len(canonical),
    )


def matching_models(query, models):
    """Return models ordered by fuzzy relevance, preserving ties stably."""
    if not query.strip():
        return list(models)

    matches = []
    for index, model in enumerate(models):
        score = fuzzy_model_score(query, model)
        if score is not None:
            matches.append((score, index, model))
    matches.sort(key=lambda item: (item[0], item[1]))
    return [model for _score, _index, model in matches]
