"""Every entity whose export carries docs must be a known attachment owner.

The two halves live in different languages: the client names the owner type when
it writes/reads an entity's README (``writeEntityDocs(..., 'data-source', id)`` in
entity-io.ts), and the server maps that name to a model here. When databases
gained a README, only the client half was updated — so every attachment call for
one answered "Unknown ownerType: data-source" (422), which aborted the whole
catalog install of a database mid-way and left it with no data.
"""

from app.api.v1.routes.attachments import _OWNER_MODELS

#: Owner types entity-io.ts passes to writeEntityDocs/readEntityDocs. Keep in step
#: with that file; `project` and `workspace` are special-cased in the route.
CLIENT_OWNER_TYPES = {
    "data-catalog",
    "data-source",
    "dq-rule-set",
    "etl-pipeline",
    "mapping-project",
    "schema-preset",
    "sql-collection",
    "user-plugin",
}


def test_every_client_owner_type_is_known():
    missing = CLIENT_OWNER_TYPES - set(_OWNER_MODELS)
    assert not missing, f"client sends owner types the server rejects: {sorted(missing)}"


def test_no_owner_type_is_registered_without_a_client_writing_it():
    extra = set(_OWNER_MODELS) - CLIENT_OWNER_TYPES
    assert not extra, f"registered but never sent (stale?): {sorted(extra)}"


def test_every_owner_model_can_be_authorized():
    """Authorization reads `entity.workspace_id`; a model without one 404s."""
    for owner_type, (model, resource) in _OWNER_MODELS.items():
        assert hasattr(model, "workspace_id"), f"{owner_type} has no workspace_id"
        assert resource, f"{owner_type} has no permission resource"
