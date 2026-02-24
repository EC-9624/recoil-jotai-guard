import {useRecoilState} from 'recoil';
import {fooState} from './atoms';

// Pattern W4: Tuple wrapper
export const useFoo = () => useRecoilState(fooState);
