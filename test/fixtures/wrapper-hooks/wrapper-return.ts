import {useSetRecoilState} from 'recoil';
import {fooState} from './atoms';

// Pattern W2: Return statement wrapper
export function useSetFoo() {
  return useSetRecoilState(fooState);
}
