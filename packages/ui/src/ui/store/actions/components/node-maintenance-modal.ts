import type {ThunkAction} from 'redux-thunk';
import filter_ from 'lodash/filter';
import partition_ from 'lodash/partition';

import format from '../../../common/hammer/format';

import {RootState} from '../../reducers';
import {
    NodeMaintenanceAction,
    NodeMaintenanceState,
} from '../../reducers/components/node-maintenance-modal';
import {
    NODE_MAINTENANCE_PARTIAL,
    NODE_MAINTENANCE_RESET,
} from '../../../constants/components/node-maintenance-modal';
import {isAllowedMaintenanceApi} from '../../../store/selectors/components/node-maintenance-modal';
import {wrapApiPromiseByToaster} from '../../../utils/utils';
import {YTApiId, ytApiV3, ytApiV3Id} from '../../../rum/rum-wrap-api';
import {AddMaintenanceParams} from '../../../../shared/yt-types';
import {updateComponentsNode} from './nodes/nodes';
import {getCurrentUserName} from 'store/selectors/global';

type NodeMaintenanceThunkAction<T = Promise<unknown>> = ThunkAction<
    T,
    RootState,
    unknown,
    NodeMaintenanceAction
>;

function makeNodePath(address: string, component: AddMaintenanceParams['component']) {
    switch (component) {
        case 'cluster_node':
            return `//sys/cluster_nodes/${address}`;
        case 'http_proxy':
            return `//sys/http_proxies/${address}`;
        case 'rpc_proxy':
            return `//sys/rpc_proxy/${address}`;
        default:
            throw new Error(`Unexpected component type: ${component}`);
    }
}

const applyObsoleteMaintenance: typeof applyMaintenance = (
    command,
    {address, type, comment: c, component},
): NodeMaintenanceThunkAction => {
    return () => {
        const path = makeNodePath(address, component);
        const isAdd = command === 'add_maintenance';
        const comment = isAdd ? c : '';
        switch (type) {
            case 'ban': {
                const banned = command === 'add_maintenance';
                return Promise.all([
                    ytApiV3.set({path: `${path}/@banned`}, banned),
                    ytApiV3.set(
                        {path: '//sys/cluster_nodes/' + address + '/@ban_message'},
                        comment,
                    ),
                ]);
            }
            case 'disable_scheduler_jobs':
            case 'disable_tablet_cells':
            case 'disable_write_sessions':
                return ytApiV3.set({path: `${path}/@${type}`}, isAdd);
            case 'decommission':
                return Promise.all([
                    ytApiV3.set({path: `${path}/@decommissioned`}, isAdd),
                    ytApiV3.set({path: `${path}/@decommission_message`}, isAdd),
                ]);
            default:
                return Promise.resolve();
        }
    };
};

export function applyMaintenance(
    command: NodeMaintenanceState['command'],
    data: Pick<AddMaintenanceParams, 'component' | 'address' | 'comment' | 'type'>,
): NodeMaintenanceThunkAction {
    return (dispatch, getState) => {
        const onSuccess = () => {
            dispatch(updateComponentsNode(data.address));
        };

        if (!isAllowedMaintenanceApi(getState())) {
            return dispatch(applyObsoleteMaintenance(command, data)).then(onSuccess);
        }

        const {component, address, comment, type} = data;

        return wrapApiPromiseByToaster(
            ytApiV3Id.executeBatch(YTApiId.addMaintenance, {
                requests: [
                    {
                        command,
                        parameters: {
                            component,
                            address,
                            type,
                            mine: true,
                            comment,
                        },
                    },
                ],
            }),
            {
                toasterName: 'add_maintenance',
                isBatch: true,
                skipSuccessToast: true,
                errorTitle: `Failed to ${format.ReadableField(command).toLowerCase()}`,
            },
        ).then(onSuccess);
    };
}

export function showNodeMaintenance(
    data: Pick<NodeMaintenanceState, 'address' | 'command' | 'component' | 'type'>,
): NodeMaintenanceThunkAction {
    return async (dispatch) => {
        const {mine, others} = await dispatch(loadNodeMaintenanceComments(data));

        return dispatch({
            type: NODE_MAINTENANCE_PARTIAL,
            data: {...data, comment: mine ?? '', otherComments: others ?? ''},
        });
    };
}

export type MaintenanceRequestInfo = {
    user: string;
    comment: string;
    timestamp: string;
    type: AddMaintenanceParams['type'];
};

export function loadNodeMaintenanceComments({
    address,
    component,
    type,
}: Pick<NodeMaintenanceState, 'address' | 'component' | 'type'>): NodeMaintenanceThunkAction<
    Promise<{mine?: string; others?: string}>
> {
    return (_dispatch, getState) => {
        if (!isAllowedMaintenanceApi(getState())) {
            return Promise.resolve({});
        }

        const user = getCurrentUserName(getState());
        const path = `${makeNodePath(address, component)}/@maintenance_requests`;

        return wrapApiPromiseByToaster(
            ytApiV3Id.get(YTApiId.maintenanceRequests, {
                path,
            }),
            {
                toasterName: 'maintenance_request_' + path,
                skipSuccessToast: true,
                errorContent: `Cannot load ${path}`,
            },
        ).then((data: Record<string, MaintenanceRequestInfo>) => {
            const [mine, others] = partition_(
                filter_(data, (item) => {
                    return item.type === type;
                }),
                (item) => {
                    return user === item.user;
                },
            );
            return {
                mine: mine.map(({timestamp, comment}) => `${timestamp}: ${comment}`).join('\n'),
                others: others
                    .map(({timestamp, user, comment}) => `${timestamp}: ${user}: ${comment}`)
                    .join('\n'),
            };
        });
    };
}

export function closeNodeMaintenanceModal(): NodeMaintenanceAction {
    return {type: NODE_MAINTENANCE_RESET};
}