import {selector} from 'recoil';
import {atom as jotaiAtom} from 'jotai';
import {jotaiStore} from './jotai/store';

// Jotai atom definition
export const myJotaiAtom = jotaiAtom('');

// Recoil selector that references Jotai state -- VIOLATION
export const badSelector = selector({
  key: 'badSelector',
  get({get}) {
    const jotaiValue = jotaiStore.get(myJotaiAtom);
    return jotaiValue;
  },
});

// Recoil selector that does NOT reference Jotai state -- OK
export const goodSelector = selector({
  key: 'goodSelector',
  get({get}) {
    return 'clean';
  },
});
