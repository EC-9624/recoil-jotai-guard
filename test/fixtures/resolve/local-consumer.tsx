import {atom, useRecoilValue} from 'recoil';

const localAtom = atom({key: 'local', default: ''});

const val = useRecoilValue(localAtom);
