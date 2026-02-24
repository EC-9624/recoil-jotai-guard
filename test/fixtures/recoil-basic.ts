import {atom, selector} from 'recoil';

export const myAtom = atom({key: 'myAtom', default: ''});
export const mySelector = selector({
  key: 'mySelector',
  get: ({get}) => get(myAtom),
});
