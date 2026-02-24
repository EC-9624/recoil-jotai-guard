import {useRecoilValue} from 'recoil';
import {coreAtom} from './barrel';

const val = useRecoilValue(coreAtom);
