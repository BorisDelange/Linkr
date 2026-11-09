# Registers the before_flush listener that bubbles child-write activity up to the
# owning element's updated_at. Imported last so every mapped class already exists.
from app.models import activity_touch  # noqa: F401
from app.models.api_token import ApiToken
from app.models.app_settings import AppSettings
from app.models.attachment import ReadmeAttachment, WikiAttachment
from app.models.code_acceptance import CodeAcceptance
from app.models.cohort import Cohort
from app.models.concept_list import ConceptList
from app.models.concept_profile import ConceptProfile
from app.models.concept_set import ConceptSet
from app.models.concept_stats_cache import ConceptStatsCache
from app.models.dashboard import Dashboard, DashboardTab, DashboardWidget
from app.models.data_catalog import DataCatalog
from app.models.data_dictionary import DataDictionary
from app.models.data_source import DataSource, DataSourceFile
from app.models.database_credential import DatabaseCredential
from app.models.dataset import DatasetAnalysis, DatasetFile
from app.models.dq_rule_set import DqCustomCheck, DqProfile, DqRuleSet, DqRunHistory
from app.models.entity_visit import EntityVisit
from app.models.environment import Environment
from app.models.etl_pipeline import EtlFile, EtlPipeline
from app.models.execution_session import ExecutionSession
from app.models.git_content_status import GitContentStatus
from app.models.git_credential import GitCredential
from app.models.git_proposal import GitProposal
from app.models.git_sync_state import GitSyncState
from app.models.ide_connection import IdeConnection
from app.models.job import Job
from app.models.mapping_project import ConceptMapping, MappingProject, ServiceMapping
from app.models.notification import Notification
from app.models.organization import Organization
from app.models.patient_dashboard import (
    PatientDashboard,
    PatientDashboardTab,
    PatientDashboardWidget,
)
from app.models.pipeline import Pipeline
from app.models.plugin import Plugin
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.pseudonym_key import PseudonymKey
from app.models.role import Role
from app.models.schema_preset import SchemaPreset
from app.models.server_run import ServerRun
from app.models.source_concept_id import SourceConceptIdEntry, SourceConceptIdRange
from app.models.sql_script import SqlScriptCollection, SqlScriptFile
from app.models.stats_cache import StatsCache
from app.models.user import User
from app.models.user_plugin import UserPlugin
from app.models.wiki_page import WikiPage
from app.models.workspace import Workspace
from app.models.workspace_member import WorkspaceMember

__all__ = [
    "Notification",
    "User",
    "GitCredential",
    "ApiToken",
    "CodeAcceptance",
    "AppSettings",
    "Project",
    "DataSource",
    "DataSourceFile",
    "DatasetFile",
    "DatasetAnalysis",
    "Cohort",
    "ConceptList",
    "ConceptSet",
    "DataDictionary",
    "Dashboard",
    "DashboardTab",
    "DashboardWidget",
    "PatientDashboard",
    "PatientDashboardTab",
    "PatientDashboardWidget",
    "ReadmeAttachment",
    "WikiAttachment",
    "ConceptProfile",
    "ServerRun",
    "ConceptStatsCache",
    "DataCatalog",
    "SourceConceptIdRange",
    "SourceConceptIdEntry",
    "MappingProject",
    "ConceptMapping",
    "ServiceMapping",
    "IdeConnection",
    "EntityVisit",
    "UserPlugin",
    "DqProfile",
    "DqRuleSet",
    "DqCustomCheck",
    "DqRunHistory",
    "EtlPipeline",
    "EtlFile",
    "ExecutionSession",
    "Environment",
    "Job",
    "Plugin",
    "Workspace",
    "WorkspaceMember",
    "ProjectMember",
    "Organization",
    "Pipeline",
    "SchemaPreset",
    "StatsCache",
    "GitProposal",
    "GitSyncState",
    "GitContentStatus",
    "SqlScriptCollection",
    "SqlScriptFile",
    "WikiPage",
    "Role",
    "DatabaseCredential",
    "PseudonymKey",
]
