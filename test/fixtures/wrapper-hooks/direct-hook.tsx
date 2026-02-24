import {useSetRecoilState, useRecoilState, useResetRecoilState} from 'recoil';
import {fooState} from './atoms';
import {barState} from './atoms';

export function DirectHookConsumer() {
  const setFoo = useSetRecoilState(fooState);
  setFoo('direct');

  const [bar, setBar] = useRecoilState(barState);
  setBar(42);

  const resetFoo = useResetRecoilState(fooState);
  resetFoo();

  return <div>{bar}</div>;
}
