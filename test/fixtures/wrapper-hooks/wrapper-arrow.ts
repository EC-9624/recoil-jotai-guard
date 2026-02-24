import {useSetRecoilState} from 'recoil';
import {fooState} from './atoms';

// Pattern W1: Arrow shorthand wrapper
export const useSetFoo = () => useSetRecoilState(fooState);
