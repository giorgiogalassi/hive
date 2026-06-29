"""
runner/vcs — VCS provider abstraction layer for Hive.

This package defines the provider-agnostic VCS interface (VCSPort) and the
normalized event dataclasses that the rest of the system uses.  Concrete
provider adapters live in submodules of this package and are never imported
directly outside of adapter setup code.

Public API
----------
VCSPort
    Abstract base class.  Concrete adapters must implement every method.
NormalizedEvent
    Union type of all normalized event dataclasses.
PROpenedEvent, PRLabeledEvent, PRReviewSubmittedEvent,
IssueCommentEvent, IssueLabeledEvent
    Individual event dataclasses.
"""

from runner.vcs.port import (
    IssueCommentEvent,
    IssueLabeledEvent,
    NormalizedEvent,
    PRLabeledEvent,
    PROpenedEvent,
    PRReviewSubmittedEvent,
    VCSPort,
)

__all__ = [
    "VCSPort",
    "NormalizedEvent",
    "PROpenedEvent",
    "PRLabeledEvent",
    "PRReviewSubmittedEvent",
    "IssueCommentEvent",
    "IssueLabeledEvent",
]
