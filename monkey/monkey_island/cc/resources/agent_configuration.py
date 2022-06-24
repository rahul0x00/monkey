import json

import marshmallow
from flask import make_response, request

from common.configuration.agent_configuration import AgentConfiguration as AgentConfigurationObject
from monkey_island.cc.repository import IAgentConfigurationRepository
from monkey_island.cc.resources.AbstractResource import AbstractResource
from monkey_island.cc.resources.request_authentication import jwt_required


class AgentConfiguration(AbstractResource):
    urls = ["/api/agent-configuration"]

    def __init__(self, agent_configuration_repository: IAgentConfigurationRepository):
        self._agent_configuration_repository = agent_configuration_repository

    @jwt_required
    def get(self):
        configuration = self._agent_configuration_repository.get_configuration()
        configuration_json = AgentConfigurationObject.to_json(configuration)
        return make_response(configuration_json, 200)

    @jwt_required
    def post(self):

        try:
            configuration_object = AgentConfigurationObject.from_json(request.data)
            self._agent_configuration_repository.store_configuration(configuration_object)
            return make_response({}, 200)
        except (marshmallow.exceptions.ValidationError, json.JSONDecodeError) as err:
            return make_response(
                {"message": f"Invalid configuration supplied: {err}"},
                400,
            )
