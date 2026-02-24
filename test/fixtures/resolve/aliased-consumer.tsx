import {useRecoilValue} from 'recoil';
import {coreAtom as localAtom} from './atom-def';

const val = useRecoilValue(localAtom);
