import {atom, selector} from 'recoil';
import {atom as jotaiAtom} from 'jotai';

// Jotai atom definition
export const jotaiFlag = jotaiAtom(false);

// Atom with inline default selector that references Jotai state -- VIOLATION
export const atomWithBadDefault = atom({
  key: 'atomWithBadDefault',
  default: selector({
    key: 'atomWithBadDefault/default',
    get({get}) {
      return jotaiFlag;
    },
  }),
});
