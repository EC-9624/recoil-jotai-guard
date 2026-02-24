import {useRecoilValue, useSetRecoilState, useRecoilState, useResetRecoilState} from 'recoil';
import {myAtom} from './recoil-basic';
import {myFamily} from './recoil-families';

function Component() {
  const val = useRecoilValue(myAtom);
  const setVal = useSetRecoilState(myAtom);
  const [state, setState] = useRecoilState(myAtom);
  const familyVal = useRecoilValue(myFamily('id'));
  const resetVal = useResetRecoilState(myAtom);
}
