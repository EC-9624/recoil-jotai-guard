import {atom, selector, atomFamily, selectorFamily} from 'recoil';

const someOtherAtom = atom({key: 'someOtherAtom', default: ''});
const initListAtom = atom({key: 'initListAtom', default: []});

export const myAtomWithDefault = atom({
  key: 'myAtomWithDefault',
  default: selector({
    key: 'myAtomWithDefault/default',
    get({get}) {
      return get(someOtherAtom);
    },
  }),
});

export const myFamilyWithDefault = atomFamily({
  key: 'myFamilyWithDefault',
  default: selectorFamily({
    key: 'myFamilyWithDefault/default',
    get:
      (id) =>
      ({get}) =>
        get(initListAtom).find((item) => item.id === id),
  }),
});
