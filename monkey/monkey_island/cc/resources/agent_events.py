import logging
import re
from bisect import bisect_left, bisect_right
from http import HTTPStatus
from typing import Iterable, Optional, Sequence, Tuple, Type

from flask import request
from flask_security import auth_token_required, roles_accepted

from common.agent_event_serializers import EVENT_TYPE_FIELD, AgentEventSerializerRegistry
from common.agent_events import EVENT_TAG_REGEX, AbstractAgentEvent, AgentEventRegistry
from common.event_queue import IAgentEventQueue
from common.types import JSONSerializable
from monkey_island.cc.flask_utils import AbstractResource
from monkey_island.cc.repositories import IAgentEventRepository
from monkey_island.cc.services.authentication_service import AccountRole

logger = logging.getLogger(__name__)


class AgentEvents(AbstractResource):
    urls = ["/api/agent-events"]

    def __init__(
        self,
        agent_event_queue: IAgentEventQueue,
        event_serializer_registry: AgentEventSerializerRegistry,
        agent_event_repository: IAgentEventRepository,
        agent_event_registry: AgentEventRegistry,
    ):
        self._agent_event_queue = agent_event_queue
        self._event_serializer_registry = event_serializer_registry
        self._agent_event_repository = agent_event_repository
        self._agent_event_registry = agent_event_registry

    @auth_token_required
    @roles_accepted(AccountRole.AGENT.name)
    def post(self):
        events = request.json

        for event in events:
            try:
                serializer = self._event_serializer_registry[event[EVENT_TYPE_FIELD]]
                deserialized_event = serializer.deserialize(event)
            except (TypeError, ValueError) as err:
                logger.exception(f"Error occurred while deserializing an event {event}: {err}")
                return {"error": str(err)}, HTTPStatus.BAD_REQUEST

            self._agent_event_queue.publish(deserialized_event)

        return {}, HTTPStatus.NO_CONTENT

    @auth_token_required
    @roles_accepted(AccountRole.ISLAND_INTERFACE.name)
    def get(self):
        try:
            type_, tag, success, timestamp_constraint = self._parse_event_filter_args()
        except Exception as err:
            return {"error": str(err)}, HTTPStatus.UNPROCESSABLE_ENTITY

        events = self._get_filtered_events(type_, tag, success, timestamp_constraint)

        try:
            serialized_events = self._serialize_events(events)
        except (TypeError, ValueError) as err:
            return {"error": str(err)}, HTTPStatus.INTERNAL_SERVER_ERROR

        return serialized_events, HTTPStatus.OK

    def _parse_event_filter_args(
        self,
    ) -> Tuple[
        Optional[Type[AbstractAgentEvent]],
        Optional[str],
        Optional[bool],
        Optional[Tuple[str, float]],
    ]:
        type_arg = request.args.get("type", None)
        tag_arg = request.args.get("tag", None)
        success_arg = request.args.get("success", None)
        timestamp_arg = request.args.get("timestamp", None)

        type_ = self._parse_type_arg(type_arg)
        tag = self._parse_tag_arg(tag_arg)
        success = self._parse_success_arg(success_arg)
        timestamp_constraint = self._parse_timestamp_arg(timestamp_arg)

        return type_, tag, success, timestamp_constraint

    def _parse_type_arg(self, type_arg: Optional[str]) -> Optional[Type[AbstractAgentEvent]]:
        try:
            type_ = None if type_arg is None else self._agent_event_registry[type_arg]
        except KeyError:
            raise ValueError(f'Unknown agent event type "{type_arg}"')

        return type_

    def _parse_tag_arg(self, tag_arg: Optional[str]) -> Optional[str]:
        if tag_arg and not re.match(pattern=re.compile(EVENT_TAG_REGEX), string=tag_arg):
            raise ValueError(f'Invalid event tag "{tag_arg}"')

        return tag_arg

    def _parse_success_arg(self, success_arg: Optional[str]) -> Optional[bool]:
        if success_arg is None:
            success = None
        elif success_arg == "true":
            success = True
        elif success_arg == "false":
            success = False
        else:
            raise ValueError(
                f'Invalid value for success "{success_arg}", expected "true" or "false"'
            )

        return success

    def _parse_timestamp_arg(self, timestamp_arg: Optional[str]) -> Optional[Tuple[str, float]]:
        if timestamp_arg is None:
            timestamp_constraint = None
        else:
            operator, timestamp = timestamp_arg.split(":")
            if not operator or not timestamp or operator not in ("gt", "lt"):
                raise ValueError(
                    f'Invalid timestamp argument "{timestamp_arg}", '
                    'expected format: "{gt,lt}:<timestamp>"'
                )
            try:
                timestamp_constraint = (operator, float(timestamp))
            except Exception:
                raise ValueError(
                    f'Invalid timestamp argument "{timestamp_arg}", '
                    "expected timestamp to be a number"
                )

        return timestamp_constraint

    def _get_filtered_events(
        self,
        type_: Optional[Type[AbstractAgentEvent]],
        tag: Optional[str],
        success: Optional[bool],
        timestamp_constraint: Optional[Tuple[str, float]],
    ) -> Sequence[AbstractAgentEvent]:
        if type_ is not None:
            events_by_type: Sequence[
                AbstractAgentEvent
            ] = self._agent_event_repository.get_events_by_type(type_)
        else:
            events_by_type = self._agent_event_repository.get_events()

        if tag is not None:
            events_by_tag: Sequence[
                AbstractAgentEvent
            ] = self._agent_event_repository.get_events_by_tag(tag)
        else:
            events_by_tag = self._agent_event_repository.get_events()

        # this has better time complexity than converting both lists to sets,
        # finding their intersection, and then sorting the resultant set by timestamp
        events = [event for event in events_by_tag if event in events_by_type]

        if success is not None:
            events = list(filter(lambda e: hasattr(e, "success") and e.success is success, events))  # type: ignore[attr-defined]  # noqa: E501

        if timestamp_constraint is not None:
            operator, timestamp = timestamp_constraint
            if operator == "gt":
                separation_point = bisect_right(
                    events, timestamp, key=lambda event: event.timestamp
                )
                events = events[separation_point:]
            elif operator == "lt":
                separation_point = bisect_left(events, timestamp, key=lambda event: event.timestamp)
                events = events[:separation_point]

        return events

    def _serialize_events(self, events: Iterable[AbstractAgentEvent]) -> JSONSerializable:
        serialized_events = []

        for event in events:
            try:
                serializer = self._event_serializer_registry[event.__class__]
                serialized_event = serializer.serialize(event)
                serialized_events.append(serialized_event)
            except (TypeError, ValueError) as err:
                logger.exception(f"Error occurred while serializing an event {event}: {err}")
                raise err

        return serialized_events
