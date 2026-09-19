from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ScrapeRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2_048)


class ScrapeAccepted(BaseModel):
    job_id: str
    status: str
    status_url: str


class APIError(BaseModel):
    detail: str


class ScopeRequest(BaseModel):
    mode: Literal["all", "selected", "single"] = "all"
    date_from: date | None = None
    date_to: date | None = None
    event_ids: list[str] = Field(default_factory=list, max_length=5_000)
    event_urls: list[str] = Field(default_factory=list, max_length=5_000)
    url: str | None = Field(default=None, max_length=2_048)

    @model_validator(mode="after")
    def validate_scope(self) -> "ScopeRequest":
        if self.date_from and self.date_to and self.date_to < self.date_from:
            raise ValueError("A data final deve ser igual ou posterior à data inicial.")
        if self.mode == "selected" and not (self.event_ids or self.event_urls):
            raise ValueError("Selecione pelo menos uma prova.")
        if self.mode == "single" and not (self.url or self.event_urls):
            raise ValueError("Informe a URL da prova.")
        if self.mode == "all" and (self.event_ids or self.event_urls or self.url):
            raise ValueError("O escopo 'all' não aceita uma seleção de provas.")
        return self


class DiscoverEventsRequest(BaseModel):
    date_from: date | None = None
    date_to: date | None = None

    @model_validator(mode="after")
    def validate_dates(self) -> "DiscoverEventsRequest":
        if self.date_from and self.date_to and self.date_to < self.date_from:
            raise ValueError("A data final deve ser igual ou posterior à data inicial.")
        return self


class MetadataRequest(BaseModel):
    scope: ScopeRequest = Field(default_factory=ScopeRequest)
    enrich_roadrunners: bool = False


class ResultsRequest(BaseModel):
    scope: ScopeRequest
    confirm_all: bool = False

    @model_validator(mode="after")
    def confirm_unbounded_scope(self) -> "ResultsRequest":
        if self.scope.mode == "all" and not self.confirm_all:
            raise ValueError("Confirme explicitamente a extração de todas as provas com confirm_all=true.")
        return self
