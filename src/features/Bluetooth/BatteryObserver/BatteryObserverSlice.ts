import { SagaIterator } from '@redux-saga/types';
import {
  actionChannel,
  fork,
  take,
  delay,
  call,
  all,
  put,
  takeLeading,
  race,
  select,
} from 'redux-saga/effects';
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { SensorState } from '../../Entities/Sensor/SensorSlice';
import { REDUCER, MILLISECONDS } from '~constants';
import { SensorAction, SensorManager } from '~features/Entities';
import { getDependency } from '~features/utils/saga';
import { BleService } from 'msupply-ble-service';
import { isSensorDownloading } from '../Download/DownloadSlice';

const INFO_RETRIES = 2;

interface BatteryObserverState {
  updatingById: Record<string, boolean>;
  isWatching: boolean;
}

export const BatteryObserverInitialState: BatteryObserverState = {
  updatingById: {},
  isWatching: false,
};

interface BatteryUpdatePayload {
  sensorId: string;
}

const reducers = {
  start: (draftState: BatteryObserverState) => {
    draftState.isWatching = true;
  },
  stop: (draftState: BatteryObserverState) => {
    draftState.isWatching = false;
  },
  updateStart: {
    prepare: (sensorId: string) => ({ payload: { sensorId } }),
    reducer: (
      draftState: BatteryObserverState,
      { payload: { sensorId } }: PayloadAction<BatteryUpdatePayload>
    ) => {
      draftState.updatingById[sensorId] = true;
    },
  },
  updateComplete: {
    prepare: (sensorId: string) => ({ payload: { sensorId } }),
    reducer: (
      draftState: BatteryObserverState,
      { payload: { sensorId } }: PayloadAction<BatteryUpdatePayload>
    ) => {
      draftState.updatingById[sensorId] = false;
    },
  },

  updateSuccess: {
    prepare: (macAddress: string, batteryLevel: string) => ({
      payload: { macAddress, batteryLevel },
    }),
    reducer: () => {},
  },

  updateFail: {
    prepare: (macAddress: string, errorMessage: string) => ({
      payload: { macAddress, errorMessage },
    }),
    reducer: () => {},
  },
  tryUpdateBatteryForSensor: {
    prepare: (sensorId: string) => ({ payload: { sensorId } }),
    reducer: () => {},
  },
};

const { actions: BatteryObserverAction, reducer: BatteryObserverReducer } = createSlice({
  initialState: BatteryObserverInitialState,
  name: REDUCER.BATTERY_OBSERVER,
  reducers,
});

const BatteryObserverSelector = {};

function* tryBatteryUpdateForSensor({
  payload: { sensorId },
}: PayloadAction<BatteryUpdatePayload>): SagaIterator {
  const btService: BleService = yield call(getDependency, 'bleService');
  const sensorManager: SensorManager = yield call(getDependency, 'sensorManager');
  const { macAddress } = yield call(sensorManager.getSensorById, sensorId);

  const isDownloading = yield select(isSensorDownloading(sensorId));
  if (!isDownloading) {
    try {
      yield put(BatteryObserverAction.updateStart(sensorId));

      const { batteryLevel } = yield call(
        btService.getInfoWithRetries,
        macAddress,
        INFO_RETRIES,
        null
      );

      if (batteryLevel !== null) {
        console.log(`BleService battery ${macAddress} ${batteryLevel}`);
        yield put(SensorAction.update(sensorId, 'batteryLevel', batteryLevel));
        yield put(BatteryObserverAction.updateSuccess(macAddress, batteryLevel));
      } else {
        yield put(BatteryObserverAction.updateFail(macAddress, 'battery Level null'));
      }
    } catch (error) {
      yield put(
        BatteryObserverAction.updateFail(macAddress, error ? error.toString() : 'fail: no message')
      );
    }
    yield put(BatteryObserverAction.updateComplete(sensorId));
  }
}

function* updateBatteryLevels(): SagaIterator {
  const sensorManager: SensorManager = yield call(getDependency, 'sensorManager');

  try {
    const sensors: SensorState[] = yield call(sensorManager.getAll);
    const mapper = ({ id }: SensorState) =>
      put(BatteryObserverAction.tryUpdateBatteryForSensor(id));
    const actions = sensors.map(mapper);
    yield all(actions);
    // eslint-disable-next-line no-empty
  } catch (error) {}
}

function* start(): SagaIterator {
  while (true) {
    yield call(updateBatteryLevels);
    yield delay(MILLISECONDS.TEN_MINUTES);
  }
}

function* watchBatteryLevels(): SagaIterator {
  yield race({
    start: call(start),
    stop: take(BatteryObserverAction.stop),
  });
}
function* queueBatteryUpdates(): SagaIterator {
  const channel = yield actionChannel(BatteryObserverAction.tryUpdateBatteryForSensor);

  while (true) {
    const action = yield take(channel);
    yield call(tryBatteryUpdateForSensor, action);
  }
}

function* root(): SagaIterator {
  yield takeLeading(BatteryObserverAction.start, watchBatteryLevels);
  yield fork(queueBatteryUpdates);
}

const BatteryObserverSaga = { root, watchBatteryLevels, start, updateBatteryLevels };

export {
  BatteryObserverAction,
  BatteryObserverReducer,
  BatteryObserverSaga,
  BatteryObserverSelector,
};
