"""Serviços modulares do Open Results."""

from app.services.openresults.catalog import EventCatalog
from app.services.openresults.metadata import EventMetadataService

__all__ = ["EventCatalog", "EventMetadataService"]
